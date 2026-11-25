import { DateTime } from "luxon";
import { schedule, type ScheduledTask } from "node-cron";
import type { Db } from "@infrastructure/Persistence/db.js";
import { createSchedulesRepo } from "@infrastructure/Persistence/repositories.js";
import { materializeSchedule } from "./materialize.js";
import type { Metrics } from "@core/metrics.js";

// §10 — dose-generation daily 03:00 UTC; rolling today→+90d horizon per
// schedule tz; per-schedule tx; stateless tick.

export interface JobResult {
  processed: number;
  failed: number;
}

export async function runDoseGeneration(deps: {
  db: Db;
  horizonDays: number;
  metrics?: Metrics;
  now?: Date;
  onScheduleError?: (err: unknown, scheduleId: string) => void;
}): Promise<JobResult> {
  const now = deps.now ?? new Date();
  const schedulesRepo = createSchedulesRepo();
  const rows = await schedulesRepo.listAll(deps.db);
  let processed = 0;
  let failed = 0;
  for (const s of rows) {
    try {
      const today = DateTime.fromJSDate(now).setZone(s.timezone).toISODate()!;
      const to = DateTime.fromISO(today)
        .plus({ days: deps.horizonDays })
        .toISODate()!;
      await deps.db.transaction(async (tx) => {
        await materializeSchedule(
          tx,
          s.id,
          { fromDate: today, toDate: to },
          deps.metrics,
        );
      });
      processed += 1;
    } catch (err) {
      failed += 1;
      deps.onScheduleError?.(err, s.id); // §10/§14 — log + Sentry, next-run retry
    }
  }
  return { processed, failed };
}

export function registerDoseGeneration(deps: {
  db: Db;
  horizonDays: number;
  metrics: Metrics;
  reportError?: (err: unknown) => void;
}): { task: ScheduledTask; runOnce: () => Promise<JobResult> } {
  const runOnce = async (): Promise<JobResult> => {
    try {
      const result = await runDoseGeneration({
        db: deps.db,
        horizonDays: deps.horizonDays,
        metrics: deps.metrics,
        onScheduleError: deps.reportError
          ? (err) => deps.reportError?.(err)
          : undefined,
      });
      deps.metrics.incr("schedule_dose_job_runs_total", {
        job: "dose-generation",
        result: result.failed === 0 ? "success" : "partial",
      });
      return result;
    } catch (err) {
      deps.metrics.incr("schedule_dose_job_runs_total", {
        job: "dose-generation",
        result: "fail",
      });
      throw err;
    }
  };
  const task = schedule(
    "0 3 * * *",
    () => {
      void runOnce().catch((err) => deps.reportError?.(err));
    },
    { timezone: "UTC" },
  );
  return { task, runOnce };
}
