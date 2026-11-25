import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// ArchivedMedicineRef suppression registry keyed (medicineId, patientId) —
// HD-SCH-05 / LLD §5.4. Marker written by MedicineArchived consumer (ticket 18);
// consulted by materialization + due-poll.
export const archivedMedicineRefs = pgTable(
  "archived_medicine_refs",
  {
    medicineId: uuid("medicine_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.medicineId, t.patientId] }),
    index("idx_archived_refs_patient").on(t.patientId),
  ],
);

export type ArchivedMedicineRefRow = typeof archivedMedicineRefs.$inferSelect;
export type NewArchivedMedicineRefRow =
  typeof archivedMedicineRefs.$inferInsert;
