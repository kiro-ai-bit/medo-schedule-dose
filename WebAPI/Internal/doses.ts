import type { FastifyInstance } from "fastify";
import {
  DueDosesQuerySchema,
  DueDosesResponseSchema,
  HasDoseRecordsResponseSchema,
  PatientIdParamsSchema,
} from "@kiro-ai-bit/contracts";
import {
  hasDoseRecords,
  listDueDoses,
  type DoseDeps,
} from "@core/Dose/dose.js";
import { DOSE_SERVICE_ISSUERS } from "../Public/doses.js";

// Internal surface — service-JWT only (auth:"service"), internal-exempt
// rate class. Notification polls /v1/doses/due; Medicine guards deletes
// via has-dose-records; Gamification pulls the patient doses variant
// through the auth:"either" public reads.
export function registerInternalDoseRoutes(
  app: FastifyInstance,
  deps: DoseDeps,
): void {
  app.get(
    "/v1/doses/due",
    {
      config: {
        auth: "service",
        authIssuers: DOSE_SERVICE_ISSUERS,
        rateLimit: "internal",
      },
      schema: {
        querystring: DueDosesQuerySchema,
        response: { 200: DueDosesResponseSchema },
      },
    },
    async (request) => {
      const { window } = request.query as { window: string };
      return listDueDoses(deps, window as Parameters<typeof listDueDoses>[1]);
    },
  );

  app.get(
    "/v1/patients/:id/has-dose-records",
    {
      config: {
        auth: "service",
        authIssuers: DOSE_SERVICE_ISSUERS,
        rateLimit: "internal",
      },
      schema: {
        params: PatientIdParamsSchema,
        response: { 200: HasDoseRecordsResponseSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return hasDoseRecords(deps, id);
    },
  );
}
