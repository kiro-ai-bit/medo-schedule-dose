import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  auth,
  CAREGIVER_ID,
  createTestApp,
  j,
  mintPeerServiceToken,
  PATIENT_ID,
  patientToken,
  schedulePayload,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
let tok: string;
let cgTok: string;
let svcTok: string;

beforeAll(async () => {
  t = await createTestApp();
  tok = await patientToken(t);
  cgTok = await patientToken(t, CAREGIVER_ID);
  svcTok = await mintPeerServiceToken(t.keys, { iss: "medo-notification" });
  t.careStub.setHandler(async (url) => {
    const u = new URL(url);
    const active =
      u.searchParams.get("patientId") === PATIENT_ID &&
      u.searchParams.get("caregiverId") === CAREGIVER_ID;
    return { status: 200, body: { active } };
  });
});
afterAll(() => t.closeAll());

const TZ = "Asia/Karachi";

async function createScheduleWithDose(
  opts: {
    doseTime?: string;
    dates?: string[];
  } = {},
) {
  const res = await t.app.inject({
    method: "POST",
    url: `/v1/patients/${PATIENT_ID}/schedules`,
    headers: auth(tok),
    payload: schedulePayload({
      recurrence:
        opts.dates !== undefined
          ? { kind: "date-list", dates: opts.dates }
          : { kind: "rrule", rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" },
      doseTimes: [opts.doseTime ?? "08:00"],
      exceptions: [],
    }),
  });
  expect(res.statusCode).toBe(201);
  const sched = j(res) as { id: string };
  const rows = await t.servicePg.query<{ id: string; local_date: string }>(
    "SELECT id, local_date::text AS local_date FROM dose_occurrences WHERE schedule_id = $1 ORDER BY scheduled_at LIMIT 1",
    [sched.id],
  );
  return { scheduleId: sched.id, doseId: rows.rows[0].id };
}

// Move a dose row so its scheduledAt/localDate land in a chosen window vs now.
async function placeDose(
  doseId: string,
  scheduledAt: Date,
  localDate?: string,
) {
  const ldt = DateTime.fromJSDate(scheduledAt).setZone(TZ);
  const ld = localDate ?? ldt.toISODate()!;
  const dt = ldt.toFormat("HH:mm");
  await t.servicePg.query(
    "UPDATE dose_occurrences SET scheduled_at = $1, local_date = $2, dose_time = $3 WHERE id = $4",
    [scheduledAt.toISOString(), ld, dt, doseId],
  );
}

const outboxRows = () =>
  t.servicePg.query<{ event_type: string; payload: Record<string, unknown> }>(
    "SELECT event_type, payload FROM outbox ORDER BY created_at",
  );

describe("dose reads", () => {
  it("GET /v1/patients/{id}/doses — self 200 ordered + outcome filter", async () => {
    const { doseId } = await createScheduleWithDose();
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/patients/${PATIENT_ID}/doses?from=2020-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z`,
      headers: auth(tok),
    });
    expect(res.statusCode).toBe(200);
    const body = j(res) as {
      doses: { id: string; outcome: string; doseTime: string }[];
    };
    expect(body.doses.some((d) => d.id === doseId)).toBe(true);
    expect(body.doses[0].doseTime).toBe("08:00");
    const filtered = await t.app.inject({
      method: "GET",
      url: `/v1/patients/${PATIENT_ID}/doses?from=2020-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z&outcome=missed`,
      headers: auth(tok),
    });
    expect(j(filtered).doses).toHaveLength(0);
  });

  it("GET doses — caregiver allowed via check-link, stranger 403, service 200", async () => {
    const url = `/v1/patients/${PATIENT_ID}/doses?from=2020-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z`;
    const cg = await t.app.inject({
      method: "GET",
      url,
      headers: auth(cgTok),
    });
    expect(cg.statusCode).toBe(200);
    const stranger = await t.app.inject({
      method: "GET",
      url,
      headers: auth(
        await patientToken(t, "99999999-9999-4999-8999-999999999999"),
      ),
    });
    expect(stranger.statusCode).toBe(403);
    const svc = await t.app.inject({
      method: "GET",
      url,
      headers: auth(svcTok),
    });
    expect(svc.statusCode).toBe(200);
  });

  it("GET /v1/doses/{id} — detail DTO + 404 + authz", async () => {
    const { doseId } = await createScheduleWithDose();
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/doses/${doseId}`,
      headers: auth(tok),
    });
    expect(res.statusCode).toBe(200);
    const d = j(res) as Record<string, unknown>;
    expect(d.id).toBe(doseId);
    expect(d.createdAt).toBeTruthy();
    const nf = await t.app.inject({
      method: "GET",
      url: "/v1/doses/44444444-4444-4444-8444-444444444444",
      headers: auth(tok),
    });
    expect(nf.statusCode).toBe(404);
  });
});

describe("POST /v1/doses/{id}/outcome", () => {
  it("taken-on-time in on-time window → 200 + DoseOutcomeChanged outbox", async () => {
    const { doseId } = await createScheduleWithDose();
    await placeDose(doseId, new Date()); // T=now → on-time-window
    const before = (await outboxRows()).rows.length;
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(tok),
      payload: { outcome: "taken-on-time" },
    });
    expect(res.statusCode).toBe(200);
    const d = j(res) as Record<string, unknown>;
    expect(d.outcome).toBe("taken-on-time");
    expect(d.actorId).toBe(PATIENT_ID);
    expect(d.markedAt).toBeTruthy();
    const rows = (await outboxRows()).rows.slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("DoseOutcomeChanged");
    expect(rows[0].payload.outcome).toBe("taken-on-time");
    expect(rows[0].payload.actorId).toBe(PATIENT_ID);
    expect(rows[0].payload.doseId).toBe(doseId);
  });

  it("taken-late valid only in late window; contradictory class → 400", async () => {
    const { doseId } = await createScheduleWithDose();
    await placeDose(doseId, new Date()); // on-time window
    const early = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(tok),
      payload: { outcome: "taken-late" },
    });
    expect(early.statusCode).toBe(400);
    // move to late window: T = now-2h, same local day
    await placeDose(doseId, new Date(Date.now() - 2 * 3600_000));
    const late = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(tok),
      payload: { outcome: "taken-late" },
    });
    expect(late.statusCode).toBe(200);
    expect(j(late).outcome).toBe("taken-late");
  });

  it("missed outcome rejected (system-only); before-window → 409", async () => {
    const { doseId } = await createScheduleWithDose();
    await placeDose(doseId, new Date(Date.now() + 3600_000)); // T=now+1h → before-window
    const missed = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(tok),
      payload: { outcome: "missed" },
    });
    expect(missed.statusCode).toBe(400); // schema enum rejects
    const before = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(tok),
      payload: { outcome: "taken-on-time" },
    });
    expect(before.statusCode).toBe(409);
  });

  it("LWW edit: marked dose re-markable while window open; missed row → 409", async () => {
    const { doseId } = await createScheduleWithDose();
    await placeDose(doseId, new Date());
    await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(tok),
      payload: { outcome: "skipped" },
    });
    // still on-time window → edit to taken-on-time
    const edit = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(tok),
      payload: { outcome: "taken-on-time" },
    });
    expect(edit.statusCode).toBe(200);
    expect(j(edit).outcome).toBe("taken-on-time");
    // force missed → locked
    await t.servicePg.query(
      "UPDATE dose_occurrences SET outcome='missed' WHERE id=$1",
      [doseId],
    );
    const locked = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(tok),
      payload: { outcome: "skipped" },
    });
    expect(locked.statusCode).toBe(409);
  });

  it("caregiver mark attributes actorId=caregiver; non-party 403", async () => {
    const { doseId } = await createScheduleWithDose();
    await placeDose(doseId, new Date());
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(cgTok),
      payload: { outcome: "taken-on-time" },
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).actorId).toBe(CAREGIVER_ID);
    const stranger = await patientToken(
      t,
      "99999999-9999-4999-8999-999999999999",
    );
    const denied = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(stranger),
      payload: { outcome: "skipped" },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe("POST /v1/doses/{id}/snooze", () => {
  it("sets snoozedUntil ~+5min, no outbox; repeat extends; marked → 409", async () => {
    const { doseId } = await createScheduleWithDose();
    await placeDose(doseId, new Date());
    const before = (await outboxRows()).rows.length;
    const r1 = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/snooze`,
      headers: auth(tok),
    });
    expect(r1.statusCode).toBe(200);
    const s1 = j(r1).snoozedUntil as string;
    expect(s1).toBeTruthy();
    expect((await outboxRows()).rows.length).toBe(before);
    const r2 = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/snooze`,
      headers: auth(tok),
    });
    expect((j(r2).snoozedUntil as string) >= s1).toBe(true);
    await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/outcome`,
      headers: auth(tok),
      payload: { outcome: "skipped" },
    });
    const marked = await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/snooze`,
      headers: auth(tok),
    });
    expect(marked.statusCode).toBe(409);
  });
});

describe("internal reads", () => {
  it("GET /v1/doses/due — service-only; window filters + empty ok", async () => {
    const { doseId } = await createScheduleWithDose();
    await placeDose(doseId, new Date()); // on-time window
    const userDeny = await t.app.inject({
      method: "GET",
      url: "/v1/doses/due?window=on-time",
      headers: auth(tok),
    });
    expect(userDeny.statusCode).toBe(401);
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/doses/due?window=on-time",
      headers: auth(svcTok),
    });
    expect(res.statusCode).toBe(200);
    const body = j(res) as {
      doses: { doseId: string; actorId?: unknown }[];
      window: string;
      evaluatedAt: string;
    };
    expect(body.window).toBe("on-time");
    expect(body.doses.some((d) => d.doseId === doseId)).toBe(true);
    expect(body.doses[0]).not.toHaveProperty("actorId");
    const empty = await t.app.inject({
      method: "GET",
      url: "/v1/doses/due?window=missed-lock",
      headers: auth(svcTok),
    });
    expect(empty.statusCode).toBe(200);
    const bad = await t.app.inject({
      method: "GET",
      url: "/v1/doses/due?window=bogus",
      headers: auth(svcTok),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("due windows: early/on-time/late/hourly/missed-lock classification", async () => {
    const now = Date.now();
    const mk = async (offsetMin: number, localDate?: string) => {
      const { doseId } = await createScheduleWithDose();
      await placeDose(doseId, new Date(now + offsetMin * 60_000), localDate);
      return doseId;
    };
    const earlyId = await mk(20); // T=now+20 → inside early (T-30..T)
    const ontimeId = await mk(0);
    const lateId = await mk(-120); // T+120min ago → late
    const hourlyId = await mk(-300); // T+300 → hourly, same local day
    const missedId = await mk(
      -60 * 26,
      DateTime.fromMillis(now - 26 * 3600_000)
        .setZone(TZ)
        .toISODate()!,
    ); // yesterday local → missed-lock
    const due = async (w: string) =>
      (
        j(
          await t.app.inject({
            method: "GET",
            url: `/v1/doses/due?window=${w}`,
            headers: auth(svcTok),
          }),
        ) as { doses: { doseId: string }[] }
      ).doses.map((d) => d.doseId);
    expect(await due("early")).toContain(earlyId);
    expect(await due("on-time")).toContain(ontimeId);
    expect(await due("late")).toContain(lateId);
    expect(await due("hourly")).toContain(hourlyId);
    expect(await due("missed-lock")).toContain(missedId);
    // cross-checks
    expect(await due("early")).not.toContain(ontimeId);
    expect(await due("on-time")).not.toContain(earlyId);
  });

  it("snoozed + skipped_by_user + archived-suppressed excluded from due", async () => {
    const { doseId } = await createScheduleWithDose();
    await placeDose(doseId, new Date());
    await t.app.inject({
      method: "POST",
      url: `/v1/doses/${doseId}/snooze`,
      headers: auth(tok),
    });
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/doses/due?window=on-time",
      headers: auth(svcTok),
    });
    const ids = (j(res).doses as { doseId: string }[]).map((d) => d.doseId);
    expect(ids).not.toContain(doseId);
  });

  it("GET /v1/patients/{id}/has-dose-records — service-only, any state", async () => {
    const url = `/v1/patients/${PATIENT_ID}/has-dose-records`;
    const deny = await t.app.inject({
      method: "GET",
      url,
      headers: auth(tok),
    });
    expect(deny.statusCode).toBe(401);
    const res = await t.app.inject({
      method: "GET",
      url,
      headers: auth(svcTok),
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).hasDoseRecords).toBe(true);
    const empty = await t.app.inject({
      method: "GET",
      url: "/v1/patients/55555555-5555-4555-8555-555555555555/has-dose-records",
      headers: auth(svcTok),
    });
    expect(j(empty).hasDoseRecords).toBe(false);
  });
});
