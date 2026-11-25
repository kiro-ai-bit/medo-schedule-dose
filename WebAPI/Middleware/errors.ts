import type { FastifyInstance } from "fastify";
import * as Sentry from "@sentry/node";
import { AppError } from "@core/errors.js";

export {
  AppError,
  AuthError,
  ConflictError,
  DependencyError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "@core/errors.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const reqId = String(request.id);
    if (err instanceof AppError) {
      if (err.retryAfterSec)
        reply.header("Retry-After", String(err.retryAfterSec));
      return reply.code(err.status).send({
        error: {
          code: err.code,
          message: err.message,
          requestId: reqId,
          ...(err.details ? { details: err.details } : {}),
        },
      });
    }
    const pgCode =
      (err as { code?: string }).code ??
      (err as { cause?: { code?: string } }).cause?.code;
    if (typeof pgCode === "string" && /^(08|53|57|58)/.test(pgCode)) {
      return reply.code(503).send({
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          message: "database unavailable",
          requestId: reqId,
        },
      });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (
      statusCode === 400 ||
      (err as Error).name === "ZodError" ||
      (err as { code?: string }).code === "FST_ERR_VALIDATION"
    ) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "invalid request",
          requestId: reqId,
        },
      });
    }
    if (statusCode === 404) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "not found", requestId: reqId },
      });
    }
    request.log.error({ err }, "unhandled error");
    Sentry.captureException(err);
    return reply.code(500).send({
      error: { code: "INTERNAL", message: "internal error", requestId: reqId },
    });
  });
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "not found",
        requestId: String(request.id),
      },
    });
  });
}
