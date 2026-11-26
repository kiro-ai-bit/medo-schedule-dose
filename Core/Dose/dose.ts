import { DateTime } from "luxon";
import type {
  DoseDetailDto,
  DoseSummaryDto,
  DueDoseDto,
} from "@kiro-ai-bit/contracts";
import type { Db, DbTx } from "@infrastructure/Persistence/db.js";
import {
  createArchivedMedicineRefsRepo,
  createDoseOccurrencesRepo,
  createSchedulesRepo,
} from "@infrastructure/Persistence/repositories.js";
import type {
  DoseOccurrenceRow,
  ScheduleRow,
} from "@infrastructure/Persistence/schema/index.js";
import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import { resolveLocalInstant } from "@core/Schedule/localTime.js";
import {
  ConflictError,
  DependencyError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@core/errors.js";
import type { Metrics } from "@core/metrics.js";
import type { ServiceClaims, UserClaims } from "@core/types.js";

export const SNOOZE_DURATION_MINUTES = 5;

export type Actor = UserClaims | ServiceClaims;

export interface DoseDeps {
  db: Db;
  checkLink: (patientId: string, caregiverId: string) => Promise<boolean>;
  metrics?: Metrics;
  snoozeMinutes?: number;
}

// §4.3/§8.12 — self or linked caregiver; service callers pass through.
// check-link failure → DependencyError (fail-closed deny).
async function authorizePatientAccess(
  deps: DoseDeps,
  patientId: string,
  actor: Actor,
): Promise<void> {
  if (!("sub" in actor)) return; // ServiceClaims — internal trust
  if (actor.sub === patientId) return;
  let active: boolean;
  try {
    active = await deps.checkLink(patientId, actor.sub);
  } catch {
    throw new DependencyError("care check-link unavailable");
  }
  if (!active) throw new ForbiddenError("no active care link");
}

// ---- window classification (§8.5) ----------------------------------------

export type DoseWindowClass =
  "before-window" | "on-time-window" | "late-window" | "missed-locked";

function localMidnightAfter(localDate: string, tz: string): Date {
  return DateTime.fromISO(`${localDate}T00:00:00`, { zone: tz })
    .plus({ days: 1 })
    .startOf("day")
    .toJSDate();
}

// §8.5 — T recomputed from local_date+dose_time in schedule tz (not the
// stored scheduled_at, which may drift on edits).
export function classifyWindow(
  dose: { localDate: string; doseTime: string },
  scheduleTz: string,
  now: Date,
): DoseWindowClass {
  const t = resolveLocalInstant(
    dose.localDate,
    hhmm(dose.doseTime),
    scheduleTz,
  ).getTime();
  const tMinus30 = t - 30 * 60_000;
  const tPlus60 = t + 60 * 60_000;
  const midnight = localMidnightAfter(dose.localDate, scheduleTz).getTime();
  if (now.getTime() < tMinus30) return "before-window";
  if (now.getTime() <= tPlus60) return "on-time-window";
  if (now.getTime() < midnight) return "late-window";
  return "missed-locked";
}

// ---- DTO mapping ----------------------------------------------------------

function hhmm(t: string): string {
  return t.slice(0, 5);
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function toSummaryDto(row: DoseOccurrenceRow): DoseSummaryDto {
  return {
    id: row.id,
    medicineId: row.medicineId,
    patientId: row.patientId,
    scheduleId: row.scheduleId,
    localDate: row.localDate,
    doseTime: hhmm(row.doseTime),
    scheduledAt: row.scheduledAt.toISOString(),
    outcome: row.outcome as DoseSummaryDto["outcome"],
    skippedByUser: row.skippedByUser,
    snoozedUntil: iso(row.snoozedUntil),
    actorId: row.actorId,
    markedAt: iso(row.markedAt),
  };
}

export function toDetailDto(row: DoseOccurrenceRow): DoseDetailDto {
  return {
    ...toSummaryDto(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDueDoseDto(row: DoseOccurrenceRow): DueDoseDto {
  const s = toSummaryDto(row);
  return {
    doseId: s.id,
    medicineId: s.medicineId,
    patientId: s.patientId,
    scheduleId: s.scheduleId,
    localDate: s.localDate,
    doseTime: s.doseTime,
    scheduledAt: s.scheduledAt,
    outcome: s.outcome,
    skippedByUser: s.skippedByUser,
    snoozedUntil: s.snoozedUntil,
  };
}

// ---- reads ----------------------------------------------------------------

// §8.7 — all rows incl. skipped_by_user/missed; no suppression filter.
export async function listPatientDoses(
  deps: DoseDeps,
  patientId: string,
  q: { from: string; to: string; outcome?: string },
  actor: Actor,
): Promise<{ doses: DoseSummaryDto[]; from: string; to: string }> {
  await authorizePatientAccess(deps, patientId, actor);
  const dosesRepo = createDoseOccurrencesRepo();
  const rows = await dosesRepo.findPatientWindow(
    deps.db,
    patientId,
    new Date(q.from),
    new Date(q.to),
    q.outcome,
  );
  return { doses: rows.map(toSummaryDto), from: q.from, to: q.to };
}

export async function getDose(
  deps: DoseDeps,
  doseId: string,
  actor: Actor,
): Promise<DoseDetailDto> {
  const dosesRepo = createDoseOccurrencesRepo();
  const row = await dosesRepo.findById(deps.db, doseId);
  if (!row) throw new NotFoundError("dose not found");
  await authorizePatientAccess(deps, row.patientId, actor);
  return toDetailDto(row);
}

// ---- writes ---------------------------------------------------------------

// Shared pre-tx load: dose + schedule (deleted schedule → NotFound on writes,
// §8.9) → authz. Returns both rows.
async function loadForWrite(
  deps: DoseDeps,
  doseId: string,
  actor: UserClaims,
): Promise<{ dose: DoseOccurrenceRow; schedule: ScheduleRow }> {
  const dosesRepo = createDoseOccurrencesRepo();
  const schedulesRepo = createSchedulesRepo();
  const dose = await dosesRepo.findById(deps.db, doseId);
  if (!dose) throw new NotFoundError("dose not found");
  const schedule = await schedulesRepo.findById(deps.db, dose.scheduleId);
  if (!schedule) throw new NotFoundError("dose not found");
  await authorizePatientAccess(deps, dose.patientId, actor);
  return { dose, schedule };
}

// §8.9/LD-SCH-09 — accept matrix: taken-on-time only in on-time-window,
// taken-late only in late-window, skipped in either open window; missed
// system-only; edits allowed while window open (LWW); mark clears snooze.
export async function markOutcome(
  deps: DoseDeps,
  doseId: string,
  outcome: "taken-on-time" | "taken-late" | "skipped",
  actor: UserClaims,
  now: Date = new Date(),
): Promise<DoseDetailDto> {
  const { dose, schedule } = await loadForWrite(deps, doseId, actor);
  if (dose.outcome === "missed") {
    throw new ConflictError("dose is locked (missed)");
  }
  const window = classifyWindow(dose, schedule.timezone, now);
  if (window === "missed-locked" || window === "before-window") {
    throw new ConflictError("dose window is not open");
  }
  const ok =
    outcome === "skipped"
      ? true
      : outcome === "taken-on-time"
        ? window === "on-time-window"
        : window === "late-window";
  if (!ok) {
    throw new ValidationError(`outcome ${outcome} not valid in ${window}`);
  }

  const dosesRepo = createDoseOccurrencesRepo();
  const updated = await deps.db.transaction(async (tx: DbTx) => {
    const row = await dosesRepo.updateOutcome(tx, doseId, {
      outcome,
      actorId: actor.sub,
      markedAt: now,
    });
    if (!row) throw new ConflictError("dose locked by missed-lock");
    await appendOutbox(tx, {
      type: "DoseOutcomeChanged",
      payload: {
        doseId: row.id,
        medicineId: row.medicineId,
        patientId: row.patientId,
        outcome,
        actorId: actor.sub,
        occurredAt: now.toISOString(),
      },
    });
    return row;
  });
  deps.metrics?.incr("schedule_dose_outcome_marks_total", { outcome });
  return toDetailDto(updated);
}

// §6 — transient snooze: unmarked-only + unlocked; repeat extends; NO event.
export async function snoozeDose(
  deps: DoseDeps,
  doseId: string,
  actor: UserClaims,
  now: Date = new Date(),
): Promise<DoseDetailDto> {
  const { dose, schedule } = await loadForWrite(deps, doseId, actor);
  if (dose.outcome !== "unmarked") {
    throw new ConflictError("dose already has an outcome");
  }
  const window = classifyWindow(dose, schedule.timezone, now);
  if (window === "missed-locked") {
    throw new ConflictError("dose is locked (missed)");
  }
  const until = new Date(
    now.getTime() + (deps.snoozeMinutes ?? SNOOZE_DURATION_MINUTES) * 60_000,
  );
  const dosesRepo = createDoseOccurrencesRepo();
  const updated = await deps.db.transaction(async (tx: DbTx) => {
    const row = await dosesRepo.setSnooze(tx, doseId, until);
    if (!row) throw new ConflictError("dose outcome changed concurrently");
    return row;
  });
  deps.metrics?.incr("schedule_dose_snoozes_total");
  return toDetailDto(updated);
}

// ---- internal reads --------------------------------------------------------

export type DueWindow = "early" | "on-time" | "late" | "hourly" | "missed-lock";

// §8.6 — window-class filter; archived suppression + snooze expiry in base.
export async function listDueDoses(
  deps: DoseDeps,
  window: DueWindow,
  now: Date = new Date(),
): Promise<{ doses: DueDoseDto[]; window: DueWindow; evaluatedAt: string }> {
  const dosesRepo = createDoseOccurrencesRepo();
  const schedulesRepo = createSchedulesRepo();
  const refsRepo = createArchivedMedicineRefsRepo();

  const base = await dosesRepo.listDueBase(deps.db, now);
  const scheduleIds = [...new Set(base.map((d) => d.scheduleId))];
  const schedules = await schedulesRepo.findByIds(deps.db, scheduleIds);
  const tzBySchedule = new Map(schedules.map((s) => [s.id, s.timezone]));

  // HD-SCH-05 — archived-medicine suppression on (medicineId, patientId).
  const patientIds = [...new Set(base.map((d) => d.patientId))];
  const suppressed = new Set<string>();
  for (const pid of patientIds) {
    for (const ref of await refsRepo.listForPatient(deps.db, pid)) {
      suppressed.add(`${ref.medicineId}|${pid}`);
    }
  }

  const out: DueDoseDto[] = [];
  for (const d of base) {
    const tz = tzBySchedule.get(d.scheduleId);
    if (!tz) continue; // schedule deleted — retained history, not due
    if (suppressed.has(`${d.medicineId}|${d.patientId}`)) continue;
    const t = d.scheduledAt.getTime();
    const midnight = localMidnightAfter(d.localDate, tz).getTime();
    const n = now.getTime();
    let hit = false;
    switch (window) {
      case "early":
        hit = n >= t - 30 * 60_000 && n < t;
        break;
      case "on-time":
        hit = n >= t && n < t + 60 * 60_000;
        break;
      case "late":
        hit = n >= t + 60 * 60_000 && n < midnight;
        break;
      case "hourly":
        hit = n >= t && n < midnight;
        break;
      case "missed-lock": {
        const today = DateTime.fromJSDate(now).setZone(tz).toISODate()!;
        hit = d.localDate < today;
        break;
      }
    }
    if (hit) out.push(toDueDoseDto(d));
  }
  deps.metrics?.incr("schedule_dose_due_polls_total", { window });
  return { doses: out, window, evaluatedAt: now.toISOString() };
}

// §6/FR-SD-019 — any-state existence check, uncached.
export async function hasDoseRecords(
  deps: DoseDeps,
  patientId: string,
): Promise<{ hasDoseRecords: boolean }> {
  const dosesRepo = createDoseOccurrencesRepo();
  return {
    hasDoseRecords: await dosesRepo.hasAnyForPatient(deps.db, patientId),
  };
}
