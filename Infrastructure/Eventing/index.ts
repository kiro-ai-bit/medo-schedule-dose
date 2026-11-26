import {
  createConsumerWorker,
  createPublisherWorker,
  ensureConsumerOffsetsSchema,
  ensureEventingSchema,
  type ConsumerHandle,
  type Logger,
  type PublisherHandle,
  type Queryable,
} from "@kiro-ai-bit/eventing";
import type { BrokerEvent } from "@kiro-ai-bit/eventing";

export async function ensureScheduleDoseEventing(deps: {
  service: Queryable;
  broker: Queryable;
}): Promise<void> {
  await ensureEventingSchema({ service: deps.service, broker: deps.broker });
  // consumer_offsets is package-owned DDL (also mirrored in drizzle schema)
  await ensureConsumerOffsetsSchema(deps.service);
}

export async function startScheduleDosePublisher(deps: {
  service: Queryable;
  broker: Queryable | string;
  brokerDsn?: string;
  logger?: Logger;
}): Promise<PublisherHandle> {
  return createPublisherWorker({
    source: deps.service,
    broker: deps.brokerDsn ?? deps.broker,
    pollIntervalMs: 5000,
    logger: deps.logger,
  });
}

export async function startAccountDeletedConsumer(deps: {
  service: Queryable;
  broker: Queryable | string;
  brokerDsn?: string;
  dispatch: (event: BrokerEvent) => Promise<void>;
  logger?: Logger;
}): Promise<ConsumerHandle> {
  return createConsumerWorker({
    service: deps.service,
    broker: deps.brokerDsn ?? deps.broker,
    consumer: "account-deleted",
    subscribe: ["AccountDeleted"],
    dispatch: deps.dispatch,
    pollIntervalMs: 5000,
    logger: deps.logger,
  });
}

export async function startMedicineArchivedConsumer(deps: {
  service: Queryable;
  broker: Queryable | string;
  brokerDsn?: string;
  dispatch: (event: BrokerEvent) => Promise<void>;
  logger?: Logger;
}): Promise<ConsumerHandle> {
  return createConsumerWorker({
    service: deps.service,
    broker: deps.brokerDsn ?? deps.broker,
    consumer: "medicine-archived",
    subscribe: ["MedicineArchived"],
    dispatch: deps.dispatch,
    pollIntervalMs: 5000,
    logger: deps.logger,
  });
}
