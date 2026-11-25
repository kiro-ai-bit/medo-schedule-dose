import type { Db, DbTx } from "@infrastructure/Persistence/db.js";
import {
  createArchivedMedicineRefsRepo,
  createDoseOccurrencesRepo,
  createScheduleExceptionsRepo,
  createSchedulesRepo,
} from "@infrastructure/Persistence/repositories.js";
import { expandOccurrences } from "./expand.js";
import type { Metrics } from "@core/metrics.js";

// §8.3 — idempotent materialization upsert by occurrence identity
// (schedule_id, local_date, dose_slot). Protected rows = any user/system
// state (outcome != unmarked OR snoozed_until set); skipped_by_user is
// plan-derived and converges on unprotected rows (LD-SCH-10).

export interface MaterializeResult {
  inserted: number;
  updated: number;
  deleted: number;
  skipped?: "suppressed";
}

export async function materializeSchedule(
  e: Db | DbTx,
  scheduleId: string,
  horizon: { fromDate: string; toDate: string },
  metrics?: Metrics,
): Promise<MaterializeResult> {
  const schedulesRepo = createSchedulesRepo();
  const exceptionsRepo = createScheduleExceptionsRepo();
  const dosesRepo = createDoseOccurrencesRepo();
  const refsRepo = createArchivedMedicineRefsRepo();

  const schedule = await schedulesRepo.findById(e, scheduleId);
  if (!schedule) return { inserted: 0, updated: 0, deleted: 0 };

  // HD-SCH-05 — archived-medicine suppression: generation stops entirely.
  if (await refsRepo.isSuppressed(e, schedule.medicineId, schedule.patientId)) {
    return { inserted: 0, updated: 0, deleted: 0, skipped: "suppressed" };
  }

  const exceptions = await exceptionsRepo.findBySchedule(e, scheduleId);
  const specs = expandOccurrences(
    schedule,
    exceptions,
    horizon.fromDate,
    horizon.toDate,
  );

  const existing = await dosesRepo.findByScheduleDateRange(
    e,
    scheduleId,
    horizon.fromDate,
    horizon.toDate,
  );
  const byKey = new Map(
    existing.map((r) => [`${r.localDate}|${r.doseSlot}`, r]),
  );

  let inserted = 0;
  let updated = 0;
  for (const spec of specs) {
    const key = `${spec.localDate}|${spec.doseSlot}`;
    const row = byKey.get(key);
    if (row) {
      const unprotected =
        row.outcome === "unmarked" && row.snoozedUntil === null;
      if (unprotected) {
        const drifted =
          row.doseTime !== spec.doseTime ||
          row.scheduledAt.getTime() !== spec.scheduledAt.getTime() ||
          row.skippedByUser !== spec.skippedByUser;
        if (drifted) {
          await dosesRepo.convergeUnprotected(e, row.id, {
            doseTime: spec.doseTime,
            scheduledAt: spec.scheduledAt,
            skippedByUser: spec.skippedByUser,
            patientId: schedule.patientId,
            medicineId: schedule.medicineId,
          });
          updated += 1;
        }
      }
      // protected rows: untouched (FR-SD-004)
    } else {
      await dosesRepo.insert(e, {
        scheduleId,
        patientId: schedule.patientId,
        medicineId: schedule.medicineId,
        localDate: spec.localDate,
        doseTime: spec.doseTime,
        doseSlot: spec.doseSlot,
        scheduledAt: spec.scheduledAt,
        outcome: "unmarked",
        skippedByUser: spec.skippedByUser,
      });
      inserted += 1;
    }
  }

  const keepKeys = specs.map((s) => ({
    localDate: s.localDate,
    doseSlot: s.doseSlot,
  }));
  const deleted = await dosesRepo.deleteUngeneratedUnprotected(
    e,
    scheduleId,
    horizon.fromDate,
    horizon.toDate,
    keepKeys,
  );

  metrics?.incr("schedule_dose_doses_generated_total", {}, inserted);
  return { inserted, updated, deleted };
}
