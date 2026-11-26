import type { FastifyInstance } from "fastify";
import {
  DoseDetailDtoSchema,
  DoseIdParamsSchema,
  MarkDoseOutcomeRequestSchema,
  PatientDosesQuerySchema,
  PatientDosesResponseSchema,
  PatientIdParamsSchema,
  type MarkDoseOutcomeRequest,
} from "@kiro-ai-bit/contracts";
import {
  getDose,
  listPatientDoses,
  markOutcome,
  snoozeDose,
  type Actor,
  type DoseDeps,
} from "@core/Dose/dose.js";
import { ForbiddenError } from "../Middleware/errors.js";
import type { ServiceClaims, UserClaims } from "@core/types.js";

// LLD §11 — inbound service callers for dose reads: Notification (due),
// Medicine (has-dose-records), Gamification (patient dose pulls).
export const DOSE_SERVICE_ISSUERS = [
  "medo-notification",
  "medo-medicine",
  "medo-gamification",
];

// auth:"either" routes — service JWT → ServiceClaims (no check-link);
// user JWT → UserClaims (self-or-check-link authz). Token class decides
// authz chain (sibling parity, LLD §6 dual rows).
function actorOf(request: {
  user?: UserClaims;
  serviceCaller?: string;
}): Actor {
  if (request.serviceCaller) {
    return { iss: request.serviceCaller } satisfies ServiceClaims;
  }
  if (!request.user) throw new ForbiddenError("authentication required");
  return request.user;
}

function requireUser(request: { user?: UserClaims }): UserClaims {
  if (!request.user) throw new ForbiddenError("authentication required");
  return request.user;
}

export function registerDoseRoutes(app: FastifyInstance, deps: DoseDeps): void {
  app.get(
    "/v1/patients/:id/doses",
    {
      config: {
        auth: "either",
        authIssuers: DOSE_SERVICE_ISSUERS,
        rateLimit: "read",
      },
      schema: {
        params: PatientIdParamsSchema,
        querystring: PatientDosesQuerySchema,
        response: { 200: PatientDosesResponseSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const q = request.query as {
        from: string;
        to: string;
        outcome?: string;
      };
      return listPatientDoses(deps, id, q, actorOf(request));
    },
  );

  app.get(
    "/v1/doses/:id",
    {
      config: {
        auth: "either",
        authIssuers: DOSE_SERVICE_ISSUERS,
        rateLimit: "read",
      },
      schema: {
        params: DoseIdParamsSchema,
        response: { 200: DoseDetailDtoSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return getDose(deps, id, actorOf(request));
    },
  );

  app.post(
    "/v1/doses/:id/outcome",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: DoseIdParamsSchema,
        body: MarkDoseOutcomeRequestSchema,
        response: { 200: DoseDetailDtoSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      const body = request.body as MarkDoseOutcomeRequest;
      return markOutcome(deps, id, body.outcome, user);
    },
  );

  app.post(
    "/v1/doses/:id/snooze",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: DoseIdParamsSchema,
        response: { 200: DoseDetailDtoSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      return snoozeDose(deps, id, user);
    },
  );
}
