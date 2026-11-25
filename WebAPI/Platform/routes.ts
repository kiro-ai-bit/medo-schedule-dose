import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "@infrastructure/Persistence/db.js";
import type { Queryable } from "@kiro-ai-bit/eventing";
import { renderMetrics, type MetricsImpl } from "../Middleware/metrics.js";

export interface PlatformDeps {
  db: Db;
  broker: Queryable;
  metrics: MetricsImpl;
}

export function registerPlatformRoutes(
  app: FastifyInstance,
  deps: PlatformDeps,
): void {
  app.get("/health", { config: { rateLimit: "public" } }, async () => ({
    status: "ok",
  }));

  app.get(
    "/ready",
    { config: { auth: "service", rateLimit: "internal" } },
    async (request, reply) => {
      const out: Record<string, string> = {};
      try {
        await deps.db.execute(sql`SELECT 1`);
        out.schedule_dose_db = "ok";
      } catch {
        out.schedule_dose_db = "fail";
      }
      try {
        await deps.broker.query("SELECT 1 FROM events LIMIT 1");
        out.broker_db = "ok";
      } catch {
        out.broker_db = "fail";
      }
      const ok = Object.values(out).every((v) => v === "ok");
      return reply.code(ok ? 200 : 503).send({
        status: ok ? "ready" : "not_ready",
        deps: out,
      });
    },
  );

  app.get(
    "/metrics",
    { config: { auth: "service", rateLimit: "internal" } },
    async (request, reply) => {
      await renderMetrics(
        reply,
        { db: deps.db, broker: deps.broker },
        deps.metrics,
      );
    },
  );
}
