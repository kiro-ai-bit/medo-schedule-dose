// Medicine ownership read — GET /v1/medicines/{id} service-JWT (aud=medo-medicine).
// No cache — must be current (HD-SCH-09); failure → throw (Core maps 503).
export interface MedicineOwnership {
  id: string;
  patientId: string;
  archivedAt: string | null;
}

export interface MedicineClient {
  // Returns ownership subset, or null on 404.
  getMedicine(medicineId: string): Promise<MedicineOwnership | null>;
}

const REQUEST_TIMEOUT_MS = 3_000;
const RETRY_DELAY_MS = 200;

export function createMedicineClient(deps: {
  baseUrl: string;
  mintServiceToken: (aud: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): MedicineClient {
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function attempt(medicineId: string) {
    const token = await deps.mintServiceToken("medo-medicine");
    return fetchImpl(
      `${deps.baseUrl}/v1/medicines/${encodeURIComponent(medicineId)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  }

  return {
    async getMedicine(medicineId) {
      let res: Response | null = null;
      for (let i = 0; i < 2; i++) {
        try {
          res = await attempt(medicineId);
          if (res.ok || res.status === 404) break;
          if (res.status < 500) break; // permanent — no retry
        } catch {
          res = null;
        }
        if (i === 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      if (!res) throw new Error("medicine ownership read unavailable");
      if (res.status === 404) return null;
      if (!res.ok)
        throw new Error(`medicine ownership read failed: ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.id !== "string" || typeof body.patientId !== "string") {
        throw new Error("medicine ownership malformed response");
      }
      return {
        id: body.id,
        patientId: body.patientId,
        archivedAt:
          typeof body.archivedAt === "string" ? body.archivedAt : null,
      };
    },
  };
}
