import { DateTime } from "luxon";
import { schedule, type ScheduledTask } from "node-cron";
import type { Db } from "@infrastructure/Persistence/db.js";
import {
  createDoseOccurrencesRepo,
  createSchedulesRepo,
} from "@infrastructure/Persistence/repositories.js";
import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import type { Metrics } from "@core/metrics.js";

// §8.8/§10 — missed-lock-tick per-minute; schedule-local date advance locks
// prior-day unmarked doses as `missed` (system outcome, actorId absent).
// Eligibility is a pure function of stored data — no cursor; per-schedule tx;
// stateless tick retries next minute on partial failure.

export interface MissedLockResult {
  processed: number;
  locked: number;
  failed: number;
}

export async function runMissedLockTick(deps: {
  db: Db;
  metrics?: Metrics;
  now?: Date;
  onScheduleError?: (err: unknown, scheduleId: string) => void;
}): Promise<MissedLockResult> {
  const now = deps.now ?? new Date();
  const schedulesRepo = createSchedulesRepo();
  const rows = await schedulesRepo.listAll(deps.db);
  let processed = 0;
  let locked = 0;
  let failed = 0;
  for (const s of rows) {
    try {
      const scheduleLocalToday = DateTime.fromJSDate(now)
        .setZone(s.timezone)
        .toISODate()!;
      const n = await deps.db.transaction(async (tx) => {
        const dosesRepo = createDoseOccurrencesRepo();
        const lockedRows = await dosesRepo.lockPriorDayUnmarked(
          tx,
          s.id,
          scheduleLocalToday,
          now,
        );
        for (const row of lockedRows) {
          await appendOutbox(tx, {
            type: "DoseOutcomeChanged",
            payload: {
              doseId: row.id,
              medicineId: row.medicineId,
              patientId: row.patientId,
              outcome: "missed",
              occurredAt: now.toISOString(),
            },
          });
        }
        return lockedRows.length;
      });
      locked += n;
      processed += 1;
    } catch (err) {
      failed += 1;
      deps.onScheduleError?.(err, s.id);
    }
  }
  if (locked > 0) {
    deps.metrics?.incr("schedule_dose_doses_locked_total", {}, locked);
  }
  return { processed, locked, failed };
}

export function registerMissedLock(deps: {
  db: Db;
  metrics: Metrics;
  reportError?: (err: unknown) => void;
}): { task: ScheduledTask; runOnce: () => Promise<MissedLockResult> } {
  const runOnce = async (): Promise<MissedLockResult> => {
    try {
      const result = await runMissedLockTick({
        db: deps.db,
        metrics: deps.metrics,
        onScheduleError: deps.reportError
          ? (err) => deps.reportError?.(err)
          : undefined,
      });
      deps.metrics.incr("schedule_dose_job_runs_total", {
        job: "missed-lock-tick",
        result: result.failed === 0 ? "success" : "partial",
      });
      return result;
    } catch (err) {
      deps.metrics.incr("schedule_dose_job_runs_total", {
        job: "missed-lock-tick",
        result: "fail",
      });
      throw err;
    }
  };
  const task = schedule(
    "* * * * *",
    () => {
      void runOnce().catch((err) => deps.reportError?.(err));
    },
    { timezone: "UTC" },
  );
  return { task, runOnce };
}
