import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  auth,
  createTestApp,
  j,
  PATIENT_ID,
  patientToken,
  schedulePayload,
  CAREGIVER_ID,
  mintUserToken,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.closeAll();
});

const doses = (sql: string) =>
  t.servicePg.query<{ n: number }>(sql).then((r) => Number(r.rows[0]?.n ?? 0));

describe("schedule CRUD + materialization", () => {
  it("creates schedule, materializes doses, lists, gets, patches, deletes", async () => {
    const tok = await patientToken(t);
    const created = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/patients/${PATIENT_ID}/schedules`,
        headers: auth(tok),
        payload: schedulePayload(),
      }),
    );
    expect(created.id).toBeTruthy();
    expect(created.resolvedStartDate).toBeTruthy();
    expect(created.exceptions).toEqual([]);

    // materialized rows exist (weekly MWF × 2 slots over 90d horizon)
    const n = await doses(
      `SELECT count(*)::int AS n FROM dose_occurrences WHERE schedule_id='${created.id}'`,
    );
    expect(n).toBeGreaterThan(0);

    const list = j(
      await t.app.inject({
        method: "GET",
        url: `/v1/patients/${PATIENT_ID}/schedules`,
        headers: auth(tok),
      }),
    );
    expect(list.schedules).toHaveLength(1);
    expect(list.schedules[0].exceptionCount).toBe(0);

    const detail = j(
      await t.app.inject({
        method: "GET",
        url: `/v1/schedules/${created.id}`,
        headers: auth(tok),
      }),
    );
    expect(detail.id).toBe(created.id);

    // PATCH doseTimes → regeneration converges
    const patched = j(
      await t.app.inject({
        method: "PATCH",
        url: `/v1/schedules/${created.id}`,
        headers: auth(tok),
        payload: { doseTimes: ["09:00"] },
      }),
    );
    expect(patched.doseTimes).toEqual(["09:00"]);
    const slot0 = await t.servicePg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM dose_occurrences WHERE schedule_id='${created.id}' AND dose_slot=1 AND outcome='unmarked' AND snoozed_until IS NULL`,
    );
    // slot-1 rows for dates still generated are deleted by regression cleanup
    expect(Number(slot0.rows[0]?.c)).toBe(0);

    const del = j(
      await t.app.inject({
        method: "DELETE",
        url: `/v1/schedules/${created.id}`,
        headers: auth(tok),
      }),
    );
    expect(del.deleted).toBe(true);
    // future unmarked rows removed; repeat → 404
    const after = await doses(
      `SELECT count(*)::int AS n FROM dose_occurrences WHERE schedule_id='${created.id}' AND outcome='unmarked'`,
    );
    expect(after).toBe(0);
    const again = await t.app.inject({
      method: "DELETE",
      url: `/v1/schedules/${created.id}`,
      headers: auth(tok),
    });
    expect(again.statusCode).toBe(404);
  });

  it("rejects bad rrule, foreign medicine, immutable medicineId patch", async () => {
    const tok = await patientToken(t);
    const bad = await t.app.inject({
      method: "POST",
      url: `/v1/patients/${PATIENT_ID}/schedules`,
      headers: auth(tok),
      payload: schedulePayload({
        recurrence: { kind: "rrule", rrule: "FREQ=DAILY" },
      }),
    });
    expect(bad.statusCode).toBe(400);

    t.medicineStub.setHandler(async (url) => ({
      status: 200,
      body: {
        id: url.split("/v1/medicines/")[1],
        patientId: "99999999-9999-4999-8999-999999999999",
        archivedAt: null,
      },
    }));
    const foreign = await t.app.inject({
      method: "POST",
      url: `/v1/patients/${PATIENT_ID}/schedules`,
      headers: auth(tok),
      payload: schedulePayload(),
    });
    expect(foreign.statusCode).toBe(403);
    t.medicineStub.setHandler(async (url) => ({
      status: 200,
      body: {
        id: url.split("/v1/medicines/")[1],
        patientId: PATIENT_ID,
        archivedAt: null,
      },
    }));

    const created = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/patients/${PATIENT_ID}/schedules`,
        headers: auth(tok),
        payload: schedulePayload(),
      }),
    );
    const imm = await t.app.inject({
      method: "PATCH",
      url: `/v1/schedules/${created.id}`,
      headers: auth(tok),
      payload: { medicineId: "44444444-4444-4444-8444-444444444444" },
    });
    expect(imm.statusCode).toBe(400);
  });

  it("authz: caregiver denied without link, allowed with link, self unaffected", async () => {
    const cgTok = await mintUserToken(t.keys, {
      sub: CAREGIVER_ID,
      role: "Caregiver",
    });
    const denied = await t.app.inject({
      method: "GET",
      url: `/v1/patients/${PATIENT_ID}/schedules`,
      headers: auth(cgTok),
    });
    expect(denied.statusCode).toBe(403);

    t.careStub.setHandler(async () => ({
      status: 200,
      body: { active: true },
    }));
    const ok = await t.app.inject({
      method: "GET",
      url: `/v1/patients/${PATIENT_ID}/schedules`,
      headers: auth(cgTok),
    });
    expect(ok.statusCode).toBe(200);
    t.careStub.setHandler(async () => ({
      status: 200,
      body: { active: false },
    }));
  });

  it("skip exception materializes skippedByUser rows; unskip restores", async () => {
    const tok = await patientToken(t);
    // find a Monday within horizon — use explicit date-list for determinism
    const created = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/patients/${PATIENT_ID}/schedules`,
        headers: auth(tok),
        payload: schedulePayload({
          recurrence: { kind: "date-list", dates: ["2026-12-01"] },
          doseTimes: ["08:00"],
          exceptions: [{ date: "2026-12-01", kind: "skip" }],
        }),
      }),
    );
    const rows = await t.servicePg.query<{ skipped: boolean }>(
      `SELECT skipped_by_user AS skipped FROM dose_occurrences WHERE schedule_id='${created.id}'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].skipped).toBe(true);

    // PATCH remove exception → flag clears on unprotected row
    await t.app.inject({
      method: "PATCH",
      url: `/v1/schedules/${created.id}`,
      headers: auth(tok),
      payload: { exceptions: [] },
    });
    const after = await t.servicePg.query<{ skipped: boolean }>(
      `SELECT skipped_by_user AS skipped FROM dose_occurrences WHERE schedule_id='${created.id}'`,
    );
    expect(after.rows[0].skipped).toBe(false);
  });

  it("archived-medicine suppression blocks materialization", async () => {
    const tok = await patientToken(t);
    // seed suppression marker for MEDICINE_ID+PATIENT_ID
    await t.servicePg.query(
      `INSERT INTO archived_medicine_refs (medicine_id, patient_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      ["33333333-3333-4333-8333-333333333333", PATIENT_ID],
    );
    const created = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/patients/${PATIENT_ID}/schedules`,
        headers: auth(tok),
        payload: schedulePayload({
          recurrence: { kind: "date-list", dates: ["2026-12-05"] },
          doseTimes: ["08:00"],
        }),
      }),
    );
    const n = await doses(
      `SELECT count(*)::int AS n FROM dose_occurrences WHERE schedule_id='${created.id}'`,
    );
    expect(n).toBe(0);
    await t.servicePg.query(
      `DELETE FROM archived_medicine_refs WHERE medicine_id='33333333-3333-4333-8333-333333333333' AND patient_id=$1`,
      [PATIENT_ID],
    );
  });

  it("protected rows untouched by regeneration", async () => {
    const tok = await patientToken(t);
    const created = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/patients/${PATIENT_ID}/schedules`,
        headers: auth(tok),
        payload: schedulePayload({
          recurrence: { kind: "date-list", dates: ["2026-12-06"] },
          doseTimes: ["08:00"],
        }),
      }),
    );
    // mark one row as taken → protected
    await t.servicePg.query(
      `UPDATE dose_occurrences SET outcome='taken-on-time', marked_at=now() WHERE schedule_id=$1`,
      [created.id],
    );
    // PATCH doseTimes — protected row must keep outcome + old dose_time
    await t.app.inject({
      method: "PATCH",
      url: `/v1/schedules/${created.id}`,
      headers: auth(tok),
      payload: { doseTimes: ["09:30"] },
    });
    const row = await t.servicePg.query<{
      outcome: string;
      dose_time: string;
    }>(`SELECT outcome, dose_time FROM dose_occurrences WHERE schedule_id=$1`, [
      created.id,
    ]);
    expect(row.rows[0].outcome).toBe("taken-on-time");
    expect(row.rows[0].dose_time).toBe("08:00"); // frozen
  });

  it("idempotent materialization re-run produces zero diff", async () => {
    const tok = await patientToken(t);
    const created = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/patients/${PATIENT_ID}/schedules`,
        headers: auth(tok),
        payload: schedulePayload({
          recurrence: {
            kind: "date-list",
            dates: ["2026-12-02", "2026-12-03"],
          },
          doseTimes: ["08:00"],
        }),
      }),
    );
    const before = await doses(
      `SELECT count(*)::int AS n FROM dose_occurrences WHERE schedule_id='${created.id}'`,
    );
    // trigger regeneration via PATCH (same values)
    await t.app.inject({
      method: "PATCH",
      url: `/v1/schedules/${created.id}`,
      headers: auth(tok),
      payload: { exceptions: [] },
    });
    const after = await doses(
      `SELECT count(*)::int AS n FROM dose_occurrences WHERE schedule_id='${created.id}'`,
    );
    expect(after).toBe(before);
  });
});
