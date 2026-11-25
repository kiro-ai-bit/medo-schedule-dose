import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import {
  rateLimitPlugin,
  type RateLimitOptions,
} from "@kiro-ai-bit/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { JWK } from "jose";
import type { Db, DbTx } from "@infrastructure/Persistence/db.js";
import type { Queryable } from "@kiro-ai-bit/eventing";
import type { PublisherHandle } from "@kiro-ai-bit/eventing";
import {
  ensureScheduleDoseEventing,
  startScheduleDosePublisher,
} from "@infrastructure/Eventing/index.js";
import { createJwksCache } from "@infrastructure/AuthzClient/jwks.js";
import { createServiceTokenMinter } from "@infrastructure/AuthzClient/serviceToken.js";
import {
  CHECK_LINK_CACHE_TTL_MS,
  createCachedCheckLink,
  createCareCheckLinkClient,
  createCheckLinkCache,
  type CheckLinkCache,
} from "@infrastructure/AuthzClient/checkLink.js";
import { createMedicineClient } from "@infrastructure/MedicineClient/getMedicine.js";
import { registerErrorHandler } from "./Middleware/errors.js";
import { registerAuthn } from "./Middleware/authn.js";
import {
  createMetrics,
  registerRedHook,
  type MetricsImpl,
} from "./Middleware/metrics.js";
import { registerScheduleRoutes } from "./Public/schedules.js";
import { registerPlatformRoutes } from "./Platform/routes.js";
import { materializeSchedule } from "@application/Materialization/materialize.js";
import {
  registerDoseGeneration,
  type JobResult,
} from "@application/Materialization/doseGeneration.js";
import type { ScheduledTask } from "node-cron";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BROKER_DATABASE_URL: z.string().min(1),
  SERVICE_PUBLIC_KEYS: z.string().min(1),
  SERVICE_PRIVATE_KEY: z.string().min(1),
  IDENTITY_JWKS_URL: z.string().min(1),
  CARE_BASE_URL: z.string().min(1),
  MEDICINE_BASE_URL: z.string().min(1),
  SENTRY_DSN: z.string().optional().default(""),
  CHECK_LINK_CACHE_TTL_MS: z.coerce.number().int().positive().optional(),
  MATERIALIZATION_HORIZON_DAYS: z.coerce.number().int().positive().optional(),
  PORT: z.coerce.number().int().positive().default(3004),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  brokerDatabaseUrl: string;
  servicePublicKeys: Record<string, JWK[]>;
  servicePrivateKey: JWK;
  identityJwksUrl: string;
  careBaseUrl: string;
  medicineBaseUrl: string;
  sentryDsn: string;
  checkLinkCacheTtlMs: number;
  materializationHorizonDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    brokerDatabaseUrl: e.BROKER_DATABASE_URL,
    servicePublicKeys: JSON.parse(e.SERVICE_PUBLIC_KEYS) as Record<
      string,
      JWK[]
    >,
    servicePrivateKey: JSON.parse(e.SERVICE_PRIVATE_KEY) as JWK,
    identityJwksUrl: e.IDENTITY_JWKS_URL,
    careBaseUrl: e.CARE_BASE_URL,
    medicineBaseUrl: e.MEDICINE_BASE_URL,
    sentryDsn: e.SENTRY_DSN,
    checkLinkCacheTtlMs: e.CHECK_LINK_CACHE_TTL_MS ?? CHECK_LINK_CACHE_TTL_MS,
    materializationHorizonDays: e.MATERIALIZATION_HORIZON_DAYS ?? 90,
  };
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  scheduleDoseQueryable: Queryable;
  brokerQueryable: Queryable;
  brokerDsn?: string;
  rateLimitOptions?: RateLimitOptions;
  startWorkers?: boolean;
  fetchImpl?: typeof fetch;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: Db;
  metrics: MetricsImpl;
  checkLinkCache: CheckLinkCache;
  publisher?: PublisherHandle;
  doseGenerationTask?: ScheduledTask;
  doseGenerationRunOnce?: () => Promise<JobResult>;
  close: () => Promise<void>;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config } = deps;
  if (config.sentryDsn) {
    Sentry.init({ dsn: config.sentryDsn, environment: config.nodeEnv });
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && h.length > 0 ? h : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", String(request.id));
  });

  registerErrorHandler(app);

  const metrics = createMetrics();
  registerRedHook(app, metrics);

  const jwks = createJwksCache({
    jwksUrl: config.identityJwksUrl,
    fetchImpl: deps.fetchImpl,
  });

  // authN guard hook must run before rate-limit preHandler (rate-limit pkg contract)
  registerAuthn(app, {
    jwks,
    userIssuer: "medo-identity",
    userAudience: "medo",
    servicePublicKeys: config.servicePublicKeys,
    serviceAudience: "medo-schedule-dose",
  });
  await app.register(rateLimitPlugin, deps.rateLimitOptions ?? {});

  const mintServiceToken = createServiceTokenMinter(config.servicePrivateKey);
  const checkLinkClient = createCachedCheckLink(
    createCareCheckLinkClient({
      baseUrl: config.careBaseUrl,
      mintServiceToken,
      fetchImpl: deps.fetchImpl,
    }),
    createCheckLinkCache(config.checkLinkCacheTtlMs),
  );
  const medicineClient = createMedicineClient({
    baseUrl: config.medicineBaseUrl,
    mintServiceToken,
    fetchImpl: deps.fetchImpl,
  });

  const materialize = (
    scheduleId: string,
    horizon: { fromDate: string; toDate: string },
    tx: DbTx,
  ) => materializeSchedule(tx, scheduleId, horizon, metrics);

  registerScheduleRoutes(app, {
    db: deps.db,
    checkLink: checkLinkClient.checkLink,
    getMedicine: (medicineId) => medicineClient.getMedicine(medicineId),
    materialize,
    horizonDays: config.materializationHorizonDays,
    metrics,
  });
  registerPlatformRoutes(app, {
    db: deps.db,
    broker: deps.brokerQueryable,
    metrics,
  });

  await ensureScheduleDoseEventing({
    service: deps.scheduleDoseQueryable,
    broker: deps.brokerQueryable,
  });

  const publisher = deps.startWorkers
    ? await startScheduleDosePublisher({
        service: deps.scheduleDoseQueryable,
        broker: deps.brokerQueryable,
        brokerDsn: deps.brokerDsn,
        logger: { error: (m, meta) => app.log.error({ meta }, m) },
      })
    : undefined;

  // dose-generation cron — registered only when workers start (tests drive runOnce)
  const doseGen = deps.startWorkers
    ? registerDoseGeneration({
        db: deps.db,
        horizonDays: config.materializationHorizonDays,
        metrics,
        reportError: (err) => app.log.error({ err }, "dose-generation failed"),
      })
    : undefined;

  return {
    app,
    db: deps.db,
    metrics,
    checkLinkCache: checkLinkClient.cache,
    publisher,
    doseGenerationTask: doseGen?.task,
    doseGenerationRunOnce: doseGen?.runOnce,
    close: async () => {
      if (doseGen) doseGen.task.stop();
      if (publisher) await publisher.stop();
      await app.close();
    },
  };
}
