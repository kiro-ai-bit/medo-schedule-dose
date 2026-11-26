import type { Db } from "@infrastructure/Persistence/db.js";
import type { Metrics } from "@core/metrics.js";
import type { CheckLinkCache } from "@infrastructure/AuthzClient/checkLink.js";
import { purgePatientSchedules } from "@core/Schedule/schedule.js";

// LLD §8.10 — single tx purge (dose rows → schedules+cascade exceptions →
// suppression markers); catalog N/A here; no Schedule & Dose event emitted.
// Post-commit: positive-only check-link cache entries involving userId purged.
// Idempotent — redelivery finds no rows.
export async function handleAccountDeleted(
  deps: { db: Db; checkLinkCache: CheckLinkCache; metrics?: Metrics },
  event: { userId: string },
): Promise<void> {
  try {
    await purgePatientSchedules({ db: deps.db }, event.userId);
    deps.checkLinkCache.invalidateForUser(event.userId);
  } catch (err) {
    deps.metrics?.incr("schedule_dose_events_consumed_total", {
      event: "AccountDeleted",
      result: "failed",
    });
    throw err;
  }
  deps.metrics?.incr("schedule_dose_events_consumed_total", {
    event: "AccountDeleted",
    result: "success",
  });
}
