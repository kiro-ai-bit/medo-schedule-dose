import type { JWK } from "jose";

const REQUEST_TIMEOUT_MS = 3000;

// jwksCache — Identity JWKS fetch, 300s cache, refetch on unknown kid (LLD §11).
export function createJwksCache(deps: {
  jwksUrl: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
}) {
  const ttlMs = deps.ttlMs ?? 300_000;
  let cached: { keys: JWK[]; expiresAt: number } | null = null;
  return {
    async get(forceRefresh = false) {
      if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
        return cached.keys;
      }
      const fetchImpl = deps.fetchImpl ?? fetch;
      const res = await fetchImpl(deps.jwksUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      const jwks = (await res.json()) as { keys: JWK[] };
      cached = { keys: jwks.keys, expiresAt: Date.now() + ttlMs };
      return cached.keys;
    },
  };
}

export type JwksCache = ReturnType<typeof createJwksCache>;
