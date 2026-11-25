import type { FastifyInstance } from "fastify";
import { jwtVerify, createLocalJWKSet } from "jose";
import type { JWK } from "jose";
import type { UserClaims } from "@core/types.js";
import type { JwksCache } from "@infrastructure/AuthzClient/jwks.js";
import { AuthError, DependencyError, ForbiddenError } from "./errors.js";

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: "user" | "service" | "either";
  }
  interface FastifyRequest {
    user?: UserClaims;
    serviceCaller?: string;
  }
}

export interface AuthnDeps {
  jwks: JwksCache;
  userIssuer: string;
  userAudience: string;
  servicePublicKeys: Record<string, JWK[]>;
  serviceAudience: string;
}

function bearerToken(request: {
  headers: Record<string, unknown>;
}): string | null {
  const h = request.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return t.length > 0 ? t : null;
}

export function registerAuthn(app: FastifyInstance, deps: AuthnDeps): void {
  const serviceKeySets = new Map<
    string,
    ReturnType<typeof createLocalJWKSet>
  >();
  for (const [iss, keys] of Object.entries(deps.servicePublicKeys)) {
    serviceKeySets.set(iss, createLocalJWKSet({ keys: keys as JWK[] }));
  }

  async function verifyUser(token: string): Promise<UserClaims> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let keys: Awaited<ReturnType<typeof deps.jwks.get>>;
      try {
        keys = await deps.jwks.get(attempt === 1);
      } catch {
        throw new DependencyError("identity jwks unavailable");
      }
      const jwks = createLocalJWKSet({ keys: keys as JWK[] });
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: deps.userIssuer,
          audience: deps.userAudience,
        });
        const p = payload as Record<string, unknown>;
        if (
          typeof p.sub !== "string" ||
          typeof p.role !== "string" ||
          typeof p.sid !== "string"
        ) {
          throw new Error("malformed user JWT claims");
        }
        return {
          sub: p.sub,
          role: p.role,
          sid: p.sid,
          iat: (p.iat as number) ?? 0,
          exp: (p.exp as number) ?? 0,
          jti: (p.jti as string) ?? "",
          iss: (p.iss as string) ?? deps.userIssuer,
          aud: p.aud as string | string[],
        };
      } catch (err) {
        if (
          attempt === 0 &&
          (err as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY"
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  async function verifyService(
    token: string,
  ): Promise<{ iss: string } | "wrongAud" | null> {
    let sawWrongAud = false;
    for (const [iss, jwks] of serviceKeySets) {
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer: iss });
        const aud = payload.aud;
        const auds = Array.isArray(aud) ? aud : aud ? [aud] : [];
        if (auds.includes(deps.serviceAudience)) return { iss };
        sawWrongAud = true;
      } catch {
        // try next peer key
      }
    }
    return sawWrongAud ? "wrongAud" : null;
  }

  app.addHook("preValidation", async (request) => {
    const mode = request.routeOptions.config.auth;
    if (!mode) return;
    const token = bearerToken(request);
    if (!token)
      throw new AuthError(401, "UNAUTHORIZED", "missing bearer token");

    if (mode === "either") {
      // Dual surface: service JWT → serviceCaller pass; user JWT → check-link
      // authz. Token class decides authz chain (sibling parity).
      const svc = await verifyService(token);
      if (svc && svc !== "wrongAud") {
        request.serviceCaller = svc.iss;
        return;
      }
      if (svc === "wrongAud") throw new ForbiddenError("wrong audience");
      try {
        request.user = await verifyUser(token);
      } catch (err) {
        if (err instanceof DependencyError) throw err;
        throw new AuthError(401, "UNAUTHORIZED", "invalid token");
      }
      return;
    }

    if (mode === "user") {
      try {
        request.user = await verifyUser(token);
      } catch (err) {
        if (err instanceof DependencyError) throw err;
        throw new AuthError(401, "UNAUTHORIZED", "invalid token");
      }
      return;
    }

    // service
    const svc = await verifyService(token);
    if (svc && svc !== "wrongAud") {
      request.serviceCaller = svc.iss;
      return;
    }
    if (svc === "wrongAud") throw new ForbiddenError("wrong audience");
    throw new AuthError(401, "UNAUTHORIZED", "invalid service token");
  });
}
