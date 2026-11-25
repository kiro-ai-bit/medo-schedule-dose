import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { schedules } from "./schedules.js";

export const scheduleExceptions = pgTable(
  "schedule_exceptions",
  {
    scheduleId: uuid("schedule_id").notNull(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    kind: text("kind").notNull(),
    overrideTime: time("override_time"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scheduleId, t.localDate] }),
    foreignKey({
      columns: [t.scheduleId],
      foreignColumns: [schedules.id],
      name: "schedule_exceptions_schedule_fk",
    }).onDelete("cascade"),
    check(
      "schedule_exceptions_kind",
      sql`${t.kind} IN ('skip','time-override')`,
    ),
    check(
      "schedule_exceptions_override_xor",
      sql`(${t.kind} = 'time-override') = (${t.overrideTime} IS NOT NULL)`,
    ),
  ],
);

export type ScheduleExceptionRow = typeof scheduleExceptions.$inferSelect;
export type NewScheduleExceptionRow = typeof scheduleExceptions.$inferInsert;
export type ExceptionKind = "skip" | "time-override";
