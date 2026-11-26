import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  auth,
  createTestApp,
  j,
  PATIENT_ID,
  patientToken,
  schedulePayload,
  type TestApp,
} from "../helpers.js";
import { runMissedLockTick } from "@application/MissedLock/missedLock.js";

let t: TestApp;
let tok: string;

beforeAll(async () => {
  t = await createTestApp();
  tok = await patientToken(t);
});
afterAll(() => t.closeAll());

// Fake tick instant: 2026-11-26T02:00Z → Asia/Karachi local 2026-11-26 07:00
// (today=26), America/New_York local 2026-11-25 21:00 (today=25).
const NOW = new Date("2026-11-26T02:00:00.000Z");

async function createSchedule(
  opts: { doseTimes?: string[]; tz?: string } = {},
) {
  const res = await t.app.inject({
    method: "POST",
    url: `/v1/patients/${PATIENT_ID}/schedules`,
    headers: auth(tok),
    payload: schedulePayload({
      doseTimes: opts.doseTimes ?? ["08:00"],
      timezone: opts.tz ?? "Asia/Karachi",
      exceptions: [],
    }),
  });
  expect(res.statusCode).toBe(201);
  return (j(res) as { id: string }).id;
}

// First N dose rows of a schedule, earliest scheduled_at first.
async function doseIds(scheduleId: string, n: number) {
  const rows = await t.servicePg.query<{ id: string }>(
    `SELECT id FROM dose_occurrences WHERE schedule_id = $1
     ORDER BY scheduled_at, dose_slot LIMIT $2`,
    [scheduleId, n],
  );
  return rows.rows.map((r) => r.id);
}

// Move a dose row to a chosen schedule-local date/time.
async function placeLocal(
  doseId: string,
  localDate: string,
  hhmm: string,
  tz: string,
) {
  const at = DateTime.fromISO(`${localDate}T${hhmm}:00`, { zone: tz });
  await t.servicePg.query(
    `UPDATE dose_occurrences
     SET local_date = $1, dose_time = $2, scheduled_at = $3
     WHERE id = $4`,
    [localDate, hhmm, at.toJSDate().toISOString(), doseId],
  );
}

const doseRow = (id: string) =>
  t.servicePg
    .query<{
      outcome: string;
      actor_id: string | null;
      marked_at: string | null;
      skipped_by_user: boolean;
      snoozed_until: string | null;
    }>(
      `SELECT outcome, actor_id, marked_at, skipped_by_user, snoozed_until
     FROM dose_occurrences WHERE id = $1`,
      [id],
    )
    .then((r) => r.rows[0]);

const missedEventsFor = (doseId: string) =>
  t.servicePg
    .query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox
       WHERE event_type = 'DoseOutcomeChanged' AND payload->>'doseId' = $1`,
      [doseId],
    )
    .then((r) => r.rows.map((x) => x.payload));

describe("missed-lock-tick", () => {
  it("locks prior-local-day unmarked doses → missed + one event each, actorId absent", async () => {
    const schedId = await createSchedule({ doseTimes: ["08:00", "20:00"] });
    const [d1, d2] = await doseIds(schedId, 2);
    await placeLocal(d1, "2026-11-25", "08:00", "Asia/Karachi");
    await placeLocal(d2, "2026-11-25", "20:00", "Asia/Karachi");

    const result = await runMissedLockTick({ db: t.db, now: NOW });
    expect(result.failed).toBe(0);
    expect(result.locked).toBe(2); // first test — only this schedule exists

    for (const id of [d1, d2]) {
      const row = await doseRow(id);
      expect(row.outcome).toBe("missed");
      expect(row.actor_id).toBeNull();
      expect(row.marked_at).not.toBeNull();
      const events = await missedEventsFor(id);
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe("missed");
      expect(events[0]).not.toHaveProperty("actorId");
      expect(events[0].medicineId).toBeTruthy();
      expect(events[0].patientId).toBe(PATIENT_ID);
    }
  });

  it("never locks marked, plan-skipped, or same-day doses; snoozed unmarked DOES lock", async () => {
    const schedId = await createSchedule({
      doseTimes: ["08:00", "09:00", "10:00", "11:00"],
    });
    const [marked, planSkip, snoozed, today] = await doseIds(schedId, 4);
    // all moved to prior local day 2026-11-25 (Karachi today = 26)
    await placeLocal(marked, "2026-11-25", "08:00", "Asia/Karachi");
    await placeLocal(planSkip, "2026-11-25", "09:00", "Asia/Karachi");
    await placeLocal(snoozed, "2026-11-25", "10:00", "Asia/Karachi");
    await t.servicePg.query(
      `UPDATE dose_occurrences SET outcome='taken-on-time', actor_id=$2, marked_at=now()
       WHERE id=$1`,
      [marked, PATIENT_ID],
    );
    await t.servicePg.query(
      `UPDATE dose_occurrences SET skipped_by_user=true WHERE id=$1`,
      [planSkip],
    );
    await t.servicePg.query(
      `UPDATE dose_occurrences SET snoozed_until = now() + interval '5 minutes'
       WHERE id=$1`,
      [snoozed],
    );
    // 'today' row: explicit local_date = fake today (Karachi 2026-11-26)
    await placeLocal(today, "2026-11-26", "11:00", "Asia/Karachi");

    await runMissedLockTick({ db: t.db, now: NOW });

    expect((await doseRow(marked)).outcome).toBe("taken-on-time");
    const ps = await doseRow(planSkip);
    expect(ps.outcome).toBe("unmarked"); // plan-skip flag ≠ dose outcome
    expect(ps.skipped_by_user).toBe(true);
    expect((await doseRow(snoozed)).outcome).toBe("missed");
    expect((await doseRow(today)).outcome).toBe("unmarked");
    expect(await missedEventsFor(planSkip)).toHaveLength(0);
  });

  it("schedule-tz aware: same local_date locks in Karachi schedule, not in New York", async () => {
    const karachi = await createSchedule({ tz: "Asia/Karachi" });
    const [kDose] = await doseIds(karachi, 1);
    await placeLocal(kDose, "2026-11-25", "08:00", "Asia/Karachi");

    const ny = await createSchedule({ tz: "America/New_York" });
    const [nyToday, nyOlder] = await doseIds(ny, 2);
    // NY schedule-local today at NOW = 2026-11-25 → 25 is NOT past
    await placeLocal(nyToday, "2026-11-25", "08:00", "America/New_York");
    await placeLocal(nyOlder, "2026-11-24", "08:00", "America/New_York");

    await runMissedLockTick({ db: t.db, now: NOW });

    expect((await doseRow(kDose)).outcome).toBe("missed");
    expect((await doseRow(nyToday)).outcome).toBe("unmarked");
    expect((await doseRow(nyOlder)).outcome).toBe("missed");
  });

  it("idempotent: second tick emits no duplicate events, locks nothing new", async () => {
    const schedId = await createSchedule();
    const [d] = await doseIds(schedId, 1);
    await placeLocal(d, "2026-11-25", "08:00", "Asia/Karachi");

    await runMissedLockTick({ db: t.db, now: NOW });
    expect(await missedEventsFor(d)).toHaveLength(1);
    const second = await runMissedLockTick({ db: t.db, now: NOW });
    expect(await missedEventsFor(d)).toHaveLength(1);
    expect((await doseRow(d)).outcome).toBe("missed");
    expect(second.failed).toBe(0);
  });
});

describe("missed-lock wiring", () => {
  it("buildApp exposes missedLockRunOnce behind startWorkers", async () => {
    const t2 = await createTestApp({ startWorkers: true });
    try {
      expect(typeof t2.missedLockRunOnce).toBe("function");
      const result = await t2.missedLockRunOnce!();
      expect(result).toHaveProperty("processed");
      expect(result).toHaveProperty("locked");
      expect(result).toHaveProperty("failed");
      expect(t2.missedLockTask).toBeDefined();
    } finally {
      await t2.closeAll();
    }
  });
});
