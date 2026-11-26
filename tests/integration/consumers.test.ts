import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  auth,
  createTestApp,
  j,
  MEDICINE_ID,
  PATIENT_ID,
  patientToken,
  schedulePayload,
  wrap,
  type TestApp,
} from "../helpers.js";
import type { Queryable } from "@kiro-ai-bit/eventing";
import { PGlite } from "@electric-sql/pglite";
import { handleAccountDeleted } from "@application/AccountDeletion/handleAccountDeleted.js";
import { handleMedicineArchived } from "@application/MedicineArchived/handleMedicineArchived.js";
import { materializeSchedule } from "@application/Materialization/materialize.js";
import { listDueDoses } from "@core/Dose/dose.js";

let t: TestApp;
let tok: string;

beforeAll(async () => {
  t = await createTestApp();
  tok = await patientToken(t);
});
afterAll(() => t.closeAll());

const OTHER_PATIENT = "55555555-5555-4555-8555-555555555555";
const OTHER_MEDICINE = "66666666-6666-4666-8666-666666666666";

async function createScheduleFor(
  patientId: string,
  medicineId: string,
  token: string,
  doseTimes = ["08:00"],
) {
  const res = await t.app.inject({
    method: "POST",
    url: `/v1/patients/${patientId}/schedules`,
    headers: auth(token),
    payload: schedulePayload({
      medicineId,
      doseTimes,
      exceptions: [{ date: "2030-01-05", kind: "skip" }],
    }),
  });
  expect(res.statusCode).toBe(201);
  return (j(res) as { id: string }).id;
}

const count = async (sql: string, params: unknown[] = []) =>
  (await t.servicePg.query<{ c: number }>(sql, params)).rows[0].c;

async function firstDoseId(scheduleId: string) {
  const rows = await t.servicePg.query<{ id: string }>(
    `SELECT id FROM dose_occurrences WHERE schedule_id = $1
     ORDER BY scheduled_at LIMIT 1`,
    [scheduleId],
  );
  return rows.rows[0].id;
}

describe("AccountDeleted consumer", () => {
  it("purges schedules+exceptions+doses+markers for user; other patient + cache untouched; redelivery no-op", async () => {
    // stub: OTHER_MEDICINE owned by OTHER_PATIENT
    t.medicineStub.setHandler(async (url) => {
      const other = url.includes(OTHER_MEDICINE);
      const id = url.split("/v1/medicines/")[1]?.split("?")[0] ?? "";
      return {
        status: 200,
        body: {
          id,
          patientId: other ? OTHER_PATIENT : PATIENT_ID,
          archivedAt: null,
        },
      };
    });
    const otherTok = await patientToken(t, OTHER_PATIENT);

    const schedA = await createScheduleFor(PATIENT_ID, MEDICINE_ID, tok);
    const schedB = await createScheduleFor(
      OTHER_PATIENT,
      OTHER_MEDICINE,
      otherTok,
    );
    await t.servicePg.query(
      `INSERT INTO archived_medicine_refs (medicine_id, patient_id, archived_at)
       VALUES ($1, $2, now())`,
      [MEDICINE_ID, PATIENT_ID],
    );

    const invalidated: string[] = [];
    const orig = t.checkLinkCache.invalidateForUser.bind(t.checkLinkCache);
    t.checkLinkCache.invalidateForUser = (u: string) => {
      invalidated.push(u);
      orig(u);
    };
    const outboxBefore = await count(`SELECT count(*)::int c FROM outbox`);

    await handleAccountDeleted(
      { db: t.db, checkLinkCache: t.checkLinkCache, metrics: t.metrics },
      { userId: PATIENT_ID },
    );

    expect(
      await count(
        `SELECT count(*)::int c FROM dose_occurrences WHERE patient_id=$1`,
        [PATIENT_ID],
      ),
    ).toBe(0);
    expect(
      await count(`SELECT count(*)::int c FROM schedules WHERE patient_id=$1`, [
        PATIENT_ID,
      ]),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int c FROM schedule_exceptions se
         JOIN schedules s ON s.id = se.schedule_id WHERE s.patient_id = $1`,
        [PATIENT_ID],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int c FROM archived_medicine_refs WHERE patient_id=$1`,
        [PATIENT_ID],
      ),
    ).toBe(0);
    // other patient untouched
    expect(
      await count(
        `SELECT count(*)::int c FROM dose_occurrences WHERE patient_id=$1`,
        [OTHER_PATIENT],
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(`SELECT count(*)::int c FROM schedules WHERE id=$1`, [
        schedB,
      ]),
    ).toBe(1);
    expect(schedA).not.toBe(schedB);
    // no Schedule & Dose event emitted on purge
    expect(await count(`SELECT count(*)::int c FROM outbox`)).toBe(
      outboxBefore,
    );
    expect(invalidated).toEqual([PATIENT_ID]);

    // redelivery → no-op
    await handleAccountDeleted(
      { db: t.db, checkLinkCache: t.checkLinkCache, metrics: t.metrics },
      { userId: PATIENT_ID },
    );
    expect(invalidated).toEqual([PATIENT_ID, PATIENT_ID]);
    expect(
      await count(`SELECT count(*)::int c FROM schedules WHERE id=$1`, [
        schedB,
      ]),
    ).toBe(1);
  });
});

describe("MedicineArchived consumer", () => {
  it("writes suppression marker; generation stops + due-poll excludes; history rows kept; redelivery no-op", async () => {
    const schedId = await createScheduleFor(PATIENT_ID, MEDICINE_ID, tok);
    const doseId = await firstDoseId(schedId);

    const occurredAt = "2026-11-26T00:00:00.000Z";
    await handleMedicineArchived(
      { db: t.db, metrics: t.metrics },
      { medicineId: MEDICINE_ID, patientId: PATIENT_ID, occurredAt },
    );

    const marker = await t.servicePg.query<{ archived_at: string }>(
      `SELECT archived_at FROM archived_medicine_refs
       WHERE medicine_id=$1 AND patient_id=$2`,
      [MEDICINE_ID, PATIENT_ID],
    );
    expect(marker.rows).toHaveLength(1);
    expect(new Date(marker.rows[0].archived_at).toISOString()).toBe(occurredAt);

    // generation suppressed (§8.3 early-return)
    const mat = await materializeSchedule(
      t.db,
      schedId,
      { fromDate: "2031-01-01", toDate: "2031-01-31" },
      t.metrics,
    );
    expect(mat.skipped).toBe("suppressed");
    expect(mat.inserted).toBe(0);

    // due-poll excludes the unmarked dose of the archived medicine (§8.6)
    const dueDeps = {
      db: t.db,
      checkLink: async () => true,
      metrics: t.metrics,
    };
    await t.servicePg.query(
      `UPDATE dose_occurrences SET scheduled_at = now() - interval '1 hour',
         local_date = (now() AT TIME ZONE 'Asia/Karachi')::date
       WHERE id=$1`,
      [doseId],
    );
    const after = await listDueDoses(dueDeps, "hourly", new Date());
    const ids = (r: typeof after) => r.doses.map((d) => d.doseId);
    // other un-suppressed medicines' doses may appear; ours must not
    expect(ids(after)).not.toContain(doseId);

    // history row retained, still queryable
    const row = await t.servicePg.query<{ outcome: string }>(
      `SELECT outcome FROM dose_occurrences WHERE id=$1`,
      [doseId],
    );
    expect(row.rows[0].outcome).toBe("unmarked");

    // redelivery → upsert no-op, still one marker
    await handleMedicineArchived(
      { db: t.db, metrics: t.metrics },
      { medicineId: MEDICINE_ID, patientId: PATIENT_ID, occurredAt },
    );
    expect(
      await count(
        `SELECT count(*)::int c FROM archived_medicine_refs
         WHERE medicine_id=$1 AND patient_id=$2`,
        [MEDICINE_ID, PATIENT_ID],
      ),
    ).toBe(1);
  });
});

describe("consumer workers — offset after success", () => {
  it("account-deleted + medicine-archived ticks process subscribed events once", async () => {
    const { startAccountDeletedConsumer, startMedicineArchivedConsumer } =
      await import("@infrastructure/Eventing/index.js");

    const patient = "77777777-7777-4777-8777-777777777777";
    // seed a schedule directly (bypasses medicine ownership stub)
    const sched = await t.servicePg.query<{ id: string }>(
      `INSERT INTO schedules (patient_id, medicine_id, recurrence_kind, rrule,
         dose_times, timezone, start_date)
       VALUES ($1, $2, 'rrule', 'FREQ=WEEKLY;BYDAY=MO', '{08:00}',
         'Asia/Karachi', '2026-11-26') RETURNING id`,
      [patient, randomUUID()],
    );
    await t.servicePg.query(
      `INSERT INTO dose_occurrences (schedule_id, patient_id, medicine_id,
         local_date, dose_time, dose_slot, scheduled_at)
       VALUES ($1, $2, $3, '2026-11-26', '08:00', 0, now())`,
      [sched.rows[0].id, patient, randomUUID()],
    );
    const medicineId = randomUUID();

    const brokerWrap = (pg: PGlite): Queryable => wrap(pg);
    const adConsumer = await startAccountDeletedConsumer({
      service: brokerWrap(t.servicePg),
      broker: brokerWrap(t.brokerPg),
      dispatch: (event) =>
        handleAccountDeleted(
          {
            db: t.db,
            checkLinkCache: t.checkLinkCache,
            metrics: t.metrics,
          },
          { userId: event.userId as string },
        ),
    });
    const maConsumer = await startMedicineArchivedConsumer({
      service: brokerWrap(t.servicePg),
      broker: brokerWrap(t.brokerPg),
      dispatch: (event) =>
        handleMedicineArchived(
          { db: t.db, metrics: t.metrics },
          {
            medicineId: event.medicineId as string,
            patientId: event.patientId as string,
            occurredAt: event.occurredAt as string,
          },
        ),
    });

    const ins = (type: string, payload: Record<string, unknown>) => {
      const eventId = randomUUID();
      const body = {
        eventId,
        occurredAt: "2026-11-26T00:00:00.000Z",
        type,
        ...payload,
      };
      return t.brokerPg.query(
        `INSERT INTO events (event_id, event_type, payload, occurred_at)
         VALUES ($1::uuid, $2, $3::jsonb, now())`,
        [eventId, type, JSON.stringify(body)],
      );
    };

    // unrelated event type is skipped without dispatch
    await ins("ProfileChanged", { userId: patient, changedFields: ["x"] });
    await ins("AccountDeleted", { userId: patient });
    await ins("MedicineArchived", {
      medicineId,
      patientId: PATIENT_ID,
    });

    const r1 = await adConsumer.tick();
    const r2 = await maConsumer.tick();
    expect(r1.processed).toBe(1);
    expect(r1.skipped).toBe(2); // ProfileChanged + MedicineArchived not subscribed
    expect(r2.processed).toBe(1);
    expect(r2.skipped).toBe(2); // ProfileChanged + AccountDeleted not subscribed

    // effects applied
    expect(
      await count(`SELECT count(*)::int c FROM schedules WHERE patient_id=$1`, [
        patient,
      ]),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int c FROM archived_medicine_refs
         WHERE medicine_id=$1 AND patient_id=$2`,
        [medicineId, PATIENT_ID],
      ),
    ).toBe(1);

    // second tick: offsets advanced → nothing reprocessed
    const s1 = await adConsumer.tick();
    const s2 = await maConsumer.tick();
    expect(s1.processed).toBe(0);
    expect(s2.processed).toBe(0);

    await adConsumer.stop();
    await maConsumer.stop();
  });
});
