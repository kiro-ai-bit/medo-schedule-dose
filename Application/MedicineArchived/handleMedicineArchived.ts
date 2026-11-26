import type { Db } from "@infrastructure/Persistence/db.js";
import { createArchivedMedicineRefsRepo } from "@infrastructure/Persistence/repositories.js";
import type { Metrics } from "@core/metrics.js";

// LLD §8.11 — PK-idempotent marker upsert keyed (medicineId, patientId);
// effects are read-side (materialize suppression + due-poll exclusion).
// Unknown ids still write the marker (forward-suppression). No event emitted.
export async function handleMedicineArchived(
  deps: { db: Db; metrics?: Metrics },
  event: { medicineId: string; patientId: string; occurredAt: string },
): Promise<void> {
  const refsRepo = createArchivedMedicineRefsRepo();
  try {
    await deps.db.transaction(async (tx) => {
      await refsRepo.upsertMarker(
        tx,
        event.medicineId,
        event.patientId,
        new Date(event.occurredAt),
      );
    });
  } catch (err) {
    deps.metrics?.incr("schedule_dose_events_consumed_total", {
      event: "MedicineArchived",
      result: "failed",
    });
    throw err;
  }
  deps.metrics?.incr("schedule_dose_events_consumed_total", {
    event: "MedicineArchived",
    result: "success",
  });
}
