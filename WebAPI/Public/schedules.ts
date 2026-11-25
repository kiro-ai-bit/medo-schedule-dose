import type { FastifyInstance } from "fastify";
import {
  CreateScheduleRequestSchema,
  type CreateScheduleRequest,
  DeleteScheduleResponseSchema,
  PatientIdParamsSchema,
  ScheduleDetailDtoSchema,
  ScheduleIdParamsSchema,
  ScheduleListResponseSchema,
  SchedulePatchRequestSchema,
  type SchedulePatchRequest,
} from "@kiro-ai-bit/contracts";
import {
  createSchedule,
  deleteSchedule,
  editSchedule,
  getSchedule,
  listSchedules,
  type ScheduleDeps,
} from "@core/Schedule/schedule.js";
import { ForbiddenError } from "../Middleware/errors.js";
import type { UserClaims } from "@core/types.js";

function requireUser(request: { user?: UserClaims }) {
  if (!request.user) throw new ForbiddenError("authentication required");
  return request.user;
}

export function registerScheduleRoutes(
  app: FastifyInstance,
  deps: ScheduleDeps,
): void {
  app.get(
    "/v1/patients/:id/schedules",
    {
      config: { auth: "user", rateLimit: "read" },
      schema: {
        params: PatientIdParamsSchema,
        response: { 200: ScheduleListResponseSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      return listSchedules(deps, id, user);
    },
  );

  app.post(
    "/v1/patients/:id/schedules",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: PatientIdParamsSchema,
        body: CreateScheduleRequestSchema,
        response: { 201: ScheduleDetailDtoSchema },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      const body = request.body as CreateScheduleRequest;
      const result = await createSchedule(deps, id, body, user);
      return reply.code(201).send(result);
    },
  );

  app.get(
    "/v1/schedules/:id",
    {
      config: { auth: "user", rateLimit: "read" },
      schema: {
        params: ScheduleIdParamsSchema,
        response: { 200: ScheduleDetailDtoSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      return getSchedule(deps, id, user);
    },
  );

  app.patch(
    "/v1/schedules/:id",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: ScheduleIdParamsSchema,
        body: SchedulePatchRequestSchema,
        response: { 200: ScheduleDetailDtoSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      const body = request.body as SchedulePatchRequest;
      return editSchedule(deps, id, body, user);
    },
  );

  app.delete(
    "/v1/schedules/:id",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: ScheduleIdParamsSchema,
        response: { 200: DeleteScheduleResponseSchema },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as { id: string };
      return deleteSchedule(deps, id, user);
    },
  );
}
