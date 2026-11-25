import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbTx } from "./db.js";

export interface OutboxEventInput {
  type: string;
  payload: Record<string, unknown>;
  eventId?: string;
  occurredAt?: string;
}

// Same-tx outbox append — mirrors @kiro-ai-bit/eventing appendOutbox payload
// flattening ({...payload, eventId, type, occurredAt}) on the package-owned
// `outbox` table (LLD §5.5).
export async function appendOutbox(
  tx: DbTx,
  input: OutboxEventInput,
): Promise<string> {
  const occurredAt =
    typeof input.payload.occurredAt === "string"
      ? input.payload.occurredAt
      : (input.occurredAt ?? new Date().toISOString());
  const eventId = input.eventId ?? randomUUID();
  const flat: Record<string, unknown> = {
    ...input.payload,
    eventId,
    type: input.type,
    occurredAt,
  };
  await tx.execute(sql`
    INSERT INTO outbox (event_id, event_type, payload, occurred_at)
    VALUES (${eventId}::uuid, ${input.type}, ${JSON.stringify(flat)}::jsonb, ${occurredAt}::timestamptz)
  `);
  return eventId;
}
