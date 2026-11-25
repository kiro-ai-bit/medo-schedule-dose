export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSec?: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class AuthError extends AppError {}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, "VALIDATION_FAILED", message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, "CONFLICT", message, undefined, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "forbidden") {
    super(403, "FORBIDDEN", message);
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSec: number) {
    super(429, "RATE_LIMITED", "Too many requests", retryAfterSec);
  }
}

export class DependencyError extends AppError {
  constructor(message: string) {
    super(503, "DEPENDENCY_UNAVAILABLE", message);
  }
}
