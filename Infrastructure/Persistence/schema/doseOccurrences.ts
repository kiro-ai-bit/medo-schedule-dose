import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const DOSE_OUTCOMES = [
  "unmarked",
  "taken-on-time",
  "taken-late",
  "skipped",
  "missed",
] as const;
export type DoseOutcome = (typeof DOSE_OUTCOMES)[number];

const HHMM = "^([01][0-9]|2[0-3]):[0-5][0-9]$";

export const doseOccurrences = pgTable(
  "dose_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    medicineId: uuid("medicine_id").notNull(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    doseTime: text("dose_time").notNull(),
    doseSlot: integer("dose_slot").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull().default("unmarked"),
    skippedByUser: boolean("skipped_by_user").notNull().default(false),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    actorId: uuid("actor_id"),
    markedAt: timestamp("marked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("uq_dose_occurrence_identity").on(
      t.scheduleId,
      t.localDate,
      t.doseSlot,
    ),
    index("idx_doses_patient_window").on(t.patientId, t.scheduledAt),
    index("idx_doses_schedule_date").on(t.scheduleId, t.localDate),
    index("idx_doses_patient_exists").on(t.patientId),
    index("idx_doses_medicine_patient").on(t.medicineId, t.patientId),
    index("idx_doses_due_poll")
      .on(t.scheduledAt)
      .where(sql`${t.outcome} = 'unmarked' AND ${t.skippedByUser} = false`),
    check(
      "dose_occurrences_outcome",
      sql`${t.outcome} IN ('unmarked','taken-on-time','taken-late','skipped','missed')`,
    ),
    check(
      "dose_occurrences_dose_time",
      sql`${t.doseTime} ~ '${sql.raw(HHMM)}'`,
    ),
    check("dose_occurrences_dose_slot", sql`${t.doseSlot} >= 0`),
  ],
);

export type DoseOccurrenceRow = typeof doseOccurrences.$inferSelect;
export type NewDoseOccurrenceRow = typeof doseOccurrences.$inferInsert;
