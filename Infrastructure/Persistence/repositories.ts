import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  archivedMedicineRefs,
  doseOccurrences,
  scheduleExceptions,
  schedules,
} from "./schema/index.js";
import type {
  ArchivedMedicineRefRow,
  DoseOccurrenceRow,
  NewDoseOccurrenceRow,
  NewScheduleExceptionRow,
  NewScheduleRow,
  ScheduleExceptionRow,
  ScheduleRow,
} from "./schema/index.js";
import type { Db, DbTx } from "./db.js";

// Repos bind to any drizzle executor — pass the tx object (cast as Db) for
// in-transaction work; PGlite is single-connection so mixing db+tx deadlocks.

export type SchedulePatchFields = Partial<{
  recurrenceKind: "rrule" | "date-list";
  rrule: string | null;
  dateList: string[] | null;
  doseTimes: string[];
  timezone: string;
  startDate: string;
  endDate: string | null;
}>;

export function createSchedulesRepo() {
  const exec = (e: Db | DbTx) => e as unknown as Db;
  return {
    async insert(e: Db | DbTx, row: NewScheduleRow): Promise<ScheduleRow> {
      const rows = await exec(e).insert(schedules).values(row).returning();
      return rows[0];
    },
    async findById(e: Db | DbTx, id: string): Promise<ScheduleRow | null> {
      const rows = await exec(e)
        .select()
        .from(schedules)
        .where(eq(schedules.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
    async findByPatient(
      e: Db | DbTx,
      patientId: string,
    ): Promise<ScheduleRow[]> {
      return exec(e)
        .select()
        .from(schedules)
        .where(eq(schedules.patientId, patientId))
        .orderBy(asc(schedules.createdAt), schedules.id);
    },
    async listAll(e: Db | DbTx): Promise<ScheduleRow[]> {
      return exec(e).select().from(schedules).orderBy(asc(schedules.id));
    },
    async updateFields(
      e: Db | DbTx,
      id: string,
      fields: SchedulePatchFields,
    ): Promise<ScheduleRow | null> {
      const rows = await exec(e)
        .update(schedules)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(schedules.id, id))
        .returning();
      return rows[0] ?? null;
    },
    async deleteById(e: Db | DbTx, id: string): Promise<void> {
      // schedule_exceptions cascade via FK
      await exec(e).delete(schedules).where(eq(schedules.id, id));
    },
    async deleteByPatientId(e: Db | DbTx, patientId: string): Promise<void> {
      await exec(e).delete(schedules).where(eq(schedules.patientId, patientId));
    },
  };
}

export type SchedulesRepo = ReturnType<typeof createSchedulesRepo>;

export function createScheduleExceptionsRepo() {
  const exec = (e: Db | DbTx) => e as unknown as Db;
  return {
    async findBySchedule(
      e: Db | DbTx,
      scheduleId: string,
    ): Promise<ScheduleExceptionRow[]> {
      return exec(e)
        .select()
        .from(scheduleExceptions)
        .where(eq(scheduleExceptions.scheduleId, scheduleId));
    },
    // Full-set replace semantics (LD-SCH-03) — delete + insert in caller tx.
    async replaceAll(
      e: Db | DbTx,
      scheduleId: string,
      rows: NewScheduleExceptionRow[],
    ): Promise<void> {
      await exec(e)
        .delete(scheduleExceptions)
        .where(eq(scheduleExceptions.scheduleId, scheduleId));
      if (rows.length > 0) {
        await exec(e).insert(scheduleExceptions).values(rows);
      }
    },
    async countByScheduleIds(
      e: Db | DbTx,
      scheduleIds: string[],
    ): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      if (scheduleIds.length === 0) return out;
      const rows = await exec(e)
        .select({
          scheduleId: scheduleExceptions.scheduleId,
          n: sql<number>`count(*)::int`,
        })
        .from(scheduleExceptions)
        .where(inArray(scheduleExceptions.scheduleId, scheduleIds))
        .groupBy(scheduleExceptions.scheduleId);
      for (const r of rows) out.set(r.scheduleId, Number(r.n));
      return out;
    },
    // exceptions die via schedules cascade — no separate delete needed
  };
}

export type ScheduleExceptionsRepo = ReturnType<
  typeof createScheduleExceptionsRepo
>;

export function createDoseOccurrencesRepo() {
  const exec = (e: Db | DbTx) => e as unknown as Db;
  return {
    async insert(e: Db | DbTx, row: NewDoseOccurrenceRow) {
      const rows = await exec(e)
        .insert(doseOccurrences)
        .values(row)
        .returning();
      return rows[0];
    },
    async findById(
      e: Db | DbTx,
      id: string,
    ): Promise<DoseOccurrenceRow | null> {
      const rows = await exec(e)
        .select()
        .from(doseOccurrences)
        .where(eq(doseOccurrences.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
    // All rows for a schedule inside a local-date window (materialization).
    async findByScheduleDateRange(
      e: Db | DbTx,
      scheduleId: string,
      fromDate: string,
      toDate: string,
    ): Promise<DoseOccurrenceRow[]> {
      return exec(e)
        .select()
        .from(doseOccurrences)
        .where(
          and(
            eq(doseOccurrences.scheduleId, scheduleId),
            gte(doseOccurrences.localDate, fromDate),
            lte(doseOccurrences.localDate, toDate),
          ),
        );
    },
    // Convergent update of mutable plan-derived fields on unprotected rows
    // (§8.3 — scheduled_at/dose_time/patient_id/medicine_id/skipped_by_user).
    async convergeUnprotected(
      e: Db | DbTx,
      id: string,
      fields: {
        doseTime: string;
        scheduledAt: Date;
        skippedByUser: boolean;
        patientId: string;
        medicineId: string;
      },
    ): Promise<void> {
      await exec(e)
        .update(doseOccurrences)
        .set({ ...fields, updatedAt: new Date() })
        .where(
          and(
            eq(doseOccurrences.id, id),
            eq(doseOccurrences.outcome, "unmarked"),
            isNull(doseOccurrences.snoozedUntil),
          ),
        );
    },
    // Regression cleanup — delete rows no longer generated that carry no
    // user/system state (unmarked + unsnoozed). skipped_by_user is
    // plan-derived and does not protect (LD-SCH-10).
    async deleteUngeneratedUnprotected(
      e: Db | DbTx,
      scheduleId: string,
      fromDate: string,
      toDate: string,
      keepKeys: { localDate: string; doseSlot: number }[],
    ): Promise<number> {
      const notIn =
        keepKeys.length === 0
          ? sql`TRUE`
          : sql`(${doseOccurrences.localDate}, ${doseOccurrences.doseSlot}) NOT IN (${sql.join(
              keepKeys.map(
                (k) => sql`(${k.localDate}::date, ${k.doseSlot}::int)`,
              ),
              sql`, `,
            )})`;
      const res = await exec(e)
        .delete(doseOccurrences)
        .where(
          and(
            eq(doseOccurrences.scheduleId, scheduleId),
            gte(doseOccurrences.localDate, fromDate),
            lte(doseOccurrences.localDate, toDate),
            eq(doseOccurrences.outcome, "unmarked"),
            isNull(doseOccurrences.snoozedUntil),
            notIn,
          ),
        )
        .returning({ id: doseOccurrences.id });
      return res.length;
    },
    // Schedule delete — future unmarked only, local_date >= today (§8.13).
    async deleteFutureUnmarked(
      e: Db | DbTx,
      scheduleId: string,
      fromLocalDate: string,
    ): Promise<number> {
      const res = await exec(e)
        .delete(doseOccurrences)
        .where(
          and(
            eq(doseOccurrences.scheduleId, scheduleId),
            eq(doseOccurrences.outcome, "unmarked"),
            eq(doseOccurrences.skippedByUser, false),
            isNull(doseOccurrences.snoozedUntil),
            gte(doseOccurrences.localDate, fromLocalDate),
          ),
        )
        .returning({ id: doseOccurrences.id });
      return res.length;
    },
    async deleteByPatientId(e: Db | DbTx, patientId: string): Promise<void> {
      await exec(e)
        .delete(doseOccurrences)
        .where(eq(doseOccurrences.patientId, patientId));
    },
    async hasAnyForPatient(e: Db | DbTx, patientId: string): Promise<boolean> {
      const rows = await exec(e)
        .select({ id: doseOccurrences.id })
        .from(doseOccurrences)
        .where(eq(doseOccurrences.patientId, patientId))
        .limit(1);
      return rows.length > 0;
    },
  };
}

export type DoseOccurrencesRepo = ReturnType<typeof createDoseOccurrencesRepo>;

export function createConsumerOffsetsRepo() {
  const exec = (e: Db | DbTx) => e as unknown as Db;
  return {
    async getOffset(e: Db | DbTx, consumer: string): Promise<number> {
      const rows = await exec(e).execute(
        sql`SELECT last_event_id::bigint AS v FROM consumer_offsets WHERE consumer_name = ${consumer}`,
      );
      return Number((rows.rows[0] as { v?: number } | undefined)?.v ?? 0);
    },
    async advanceOffset(
      e: Db | DbTx,
      consumer: string,
      eventId: number,
    ): Promise<void> {
      await exec(e).execute(sql`
        INSERT INTO consumer_offsets (consumer_name, last_event_id, updated_at)
        VALUES (${consumer}, ${eventId}::bigint, now())
        ON CONFLICT (consumer_name) DO UPDATE
          SET last_event_id = GREATEST(consumer_offsets.last_event_id, EXCLUDED.last_event_id),
              updated_at = now()`);
    },
  };
}

export type ConsumerOffsetsRepo = ReturnType<typeof createConsumerOffsetsRepo>;

export function createArchivedMedicineRefsRepo() {
  const exec = (e: Db | DbTx) => e as unknown as Db;
  return {
    async isSuppressed(
      e: Db | DbTx,
      medicineId: string,
      patientId: string,
    ): Promise<boolean> {
      const rows = await exec(e)
        .select({ m: archivedMedicineRefs.medicineId })
        .from(archivedMedicineRefs)
        .where(
          and(
            eq(archivedMedicineRefs.medicineId, medicineId),
            eq(archivedMedicineRefs.patientId, patientId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async upsertMarker(
      e: Db | DbTx,
      medicineId: string,
      patientId: string,
      archivedAt: Date,
    ): Promise<void> {
      await exec(e)
        .insert(archivedMedicineRefs)
        .values({ medicineId, patientId, archivedAt })
        .onConflictDoUpdate({
          target: [
            archivedMedicineRefs.medicineId,
            archivedMedicineRefs.patientId,
          ],
          set: { archivedAt },
        });
    },
    async deleteByPatientId(e: Db | DbTx, patientId: string): Promise<void> {
      await exec(e)
        .delete(archivedMedicineRefs)
        .where(eq(archivedMedicineRefs.patientId, patientId));
    },
    async listForPatient(
      e: Db | DbTx,
      patientId: string,
    ): Promise<ArchivedMedicineRefRow[]> {
      return exec(e)
        .select()
        .from(archivedMedicineRefs)
        .where(eq(archivedMedicineRefs.patientId, patientId));
    },
  };
}

export type ArchivedMedicineRefsRepo = ReturnType<
  typeof createArchivedMedicineRefsRepo
>;
