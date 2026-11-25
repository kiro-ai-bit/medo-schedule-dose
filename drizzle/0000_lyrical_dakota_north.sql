CREATE TABLE "archived_medicine_refs" (
	"medicine_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archived_medicine_refs_medicine_id_patient_id_pk" PRIMARY KEY("medicine_id","patient_id")
);
--> statement-breakpoint
CREATE TABLE "consumer_offsets" (
	"consumer_name" text PRIMARY KEY NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dose_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"medicine_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"dose_time" text NOT NULL,
	"dose_slot" integer NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"outcome" text DEFAULT 'unmarked' NOT NULL,
	"skipped_by_user" boolean DEFAULT false NOT NULL,
	"snoozed_until" timestamp with time zone,
	"actor_id" uuid,
	"marked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_dose_occurrence_identity" UNIQUE("schedule_id","local_date","dose_slot"),
	CONSTRAINT "dose_occurrences_outcome" CHECK ("dose_occurrences"."outcome" IN ('unmarked','taken-on-time','taken-late','skipped','missed')),
	CONSTRAINT "dose_occurrences_dose_time" CHECK ("dose_occurrences"."dose_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "dose_occurrences_dose_slot" CHECK ("dose_occurrences"."dose_slot" >= 0)
);
--> statement-breakpoint
CREATE TABLE "schedule_exceptions" (
	"schedule_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"kind" text NOT NULL,
	"override_time" time,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_exceptions_schedule_id_local_date_pk" PRIMARY KEY("schedule_id","local_date"),
	CONSTRAINT "schedule_exceptions_kind" CHECK ("schedule_exceptions"."kind" IN ('skip','time-override')),
	CONSTRAINT "schedule_exceptions_override_xor" CHECK (("schedule_exceptions"."kind" = 'time-override') = ("schedule_exceptions"."override_time" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"medicine_id" uuid NOT NULL,
	"recurrence_kind" text NOT NULL,
	"rrule" text,
	"date_list" date[],
	"dose_times" text[] NOT NULL,
	"timezone" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_recurrence_kind" CHECK ("schedules"."recurrence_kind" IN ('rrule','date-list')),
	CONSTRAINT "schedules_rrule_xor" CHECK (("schedules"."recurrence_kind" = 'rrule') = ("schedules"."rrule" IS NOT NULL)),
	CONSTRAINT "schedules_datelist_xor" CHECK (("schedules"."recurrence_kind" = 'date-list') = ("schedules"."date_list" IS NOT NULL)),
	CONSTRAINT "schedules_dose_times" CHECK (cardinality("schedules"."dose_times") >= 1),
	CONSTRAINT "schedules_timezone_len" CHECK (length("schedules"."timezone") BETWEEN 1 AND 64),
	CONSTRAINT "schedules_end_after_start" CHECK ("schedules"."end_date" IS NULL OR "schedules"."end_date" >= "schedules"."start_date")
);
--> statement-breakpoint
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_schedule_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_archived_refs_patient" ON "archived_medicine_refs" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_doses_patient_window" ON "dose_occurrences" USING btree ("patient_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_doses_schedule_date" ON "dose_occurrences" USING btree ("schedule_id","local_date");--> statement-breakpoint
CREATE INDEX "idx_doses_patient_exists" ON "dose_occurrences" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_doses_medicine_patient" ON "dose_occurrences" USING btree ("medicine_id","patient_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_patient" ON "schedules" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_medicine" ON "schedules" USING btree ("medicine_id");