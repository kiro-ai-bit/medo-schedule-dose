import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id").notNull(),
    medicineId: uuid("medicine_id").notNull(),
    recurrenceKind: text("recurrence_kind").notNull(),
    rrule: text("rrule"),
    dateList: date("date_list", { mode: "string" }).array(),
    doseTimes: text("dose_times").array().notNull(),
    timezone: text("timezone").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_schedules_patient").on(t.patientId),
    index("idx_schedules_medicine").on(t.medicineId),
    check(
      "schedules_recurrence_kind",
      sql`${t.recurrenceKind} IN ('rrule','date-list')`,
    ),
    check(
      "schedules_rrule_xor",
      sql`(${t.recurrenceKind} = 'rrule') = (${t.rrule} IS NOT NULL)`,
    ),
    check(
      "schedules_datelist_xor",
      sql`(${t.recurrenceKind} = 'date-list') = (${t.dateList} IS NOT NULL)`,
    ),
    check("schedules_dose_times", sql`cardinality(${t.doseTimes}) >= 1`),
    check(
      "schedules_timezone_len",
      sql`length(${t.timezone}) BETWEEN 1 AND 64`,
    ),
    check(
      "schedules_end_after_start",
      sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);

export type ScheduleRow = typeof schedules.$inferSelect;
export type NewScheduleRow = typeof schedules.$inferInsert;
export type RecurrenceKind = "rrule" | "date-list";
