export const CHECK_LINK_CACHE_TTL_MS = 15_000;

export interface CheckLinkCache {
  get(key: string): boolean | null;
  set(key: string, active: boolean): void;
  invalidateForUser(userId: string): void;
}

// LD-SCH-11 — positives only, negatives never cached; invalidateForUser purges
// entries where either side = userId (AccountDeleted consumer, ticket 18).
export function createCheckLinkCache(
  ttlMs: number = CHECK_LINK_CACHE_TTL_MS,
): CheckLinkCache {
  const store = new Map<string, { active: boolean; expiresAt: number }>();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return hit.active;
    },
    set(key, active) {
      if (!active) return; // negatives never cached
      store.set(key, { active: true, expiresAt: Date.now() + ttlMs });
    },
    invalidateForUser(userId) {
      for (const key of store.keys()) {
        const [patientId, caregiverId] = key.split(":");
        if (patientId === userId || caregiverId === userId) {
          store.delete(key);
        }
      }
    },
  };
}

export interface CareCheckLinkClient {
  // GET /v1/care/check-link?patientId=&caregiverId= → {active}; throws on failure.
  checkLink(patientId: string, caregiverId: string): Promise<boolean>;
}

const REQUEST_TIMEOUT_MS = 3_000;
const RETRY_DELAY_MS = 200;

export function createCareCheckLinkClient(deps: {
  baseUrl: string;
  mintServiceToken: (aud: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): CareCheckLinkClient {
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function attempt(patientId: string, caregiverId: string) {
    const token = await deps.mintServiceToken("medo-care");
    const url =
      `${deps.baseUrl}/v1/care/check-link` +
      `?patientId=${encodeURIComponent(patientId)}` +
      `&caregiverId=${encodeURIComponent(caregiverId)}`;
    return fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async checkLink(patientId, caregiverId) {
      let res: Response | null = null;
      for (let i = 0; i < 2; i++) {
        try {
          res = await attempt(patientId, caregiverId);
          if (res.ok) break;
          if (res.status < 500) break; // permanent — no retry
        } catch {
          res = null;
        }
        if (i === 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      if (!res || !res.ok) {
        throw new Error("care check-link unavailable");
      }
      const body = (await res.json()) as { active?: unknown };
      if (typeof body.active !== "boolean") {
        throw new Error("care check-link malformed response");
      }
      return body.active;
    },
  };
}

// Cached read-through wrapper — positive-only cache per LD-SCH-11.
export function createCachedCheckLink(
  client: CareCheckLinkClient,
  cache: CheckLinkCache = createCheckLinkCache(),
): {
  checkLink: (patientId: string, caregiverId: string) => Promise<boolean>;
  cache: CheckLinkCache;
} {
  return {
    cache,
    async checkLink(patientId, caregiverId) {
      const key = `${patientId}:${caregiverId}`;
      const hit = cache.get(key);
      if (hit !== null) return hit;
      const active = await client.checkLink(patientId, caregiverId);
      cache.set(key, active);
      return active;
    },
  };
}
