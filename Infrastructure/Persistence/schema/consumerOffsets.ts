import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Package-owned shape (@kiro-ai-bit/eventing CONSUMER_OFFSETS_DDL) — kept
// identical so drizzle migrate and ensureConsumerOffsetsSchema coexist.
export const consumerOffsets = pgTable("consumer_offsets", {
  consumerName: text("consumer_name").primaryKey(),
  lastEventId: bigint("last_event_id", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ConsumerOffsetRow = typeof consumerOffsets.$inferSelect;
