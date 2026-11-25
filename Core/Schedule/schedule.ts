import { DateTime } from "luxon";
import type {
  CreateScheduleRequest,
  ScheduleDetailDto,
  SchedulePatchRequest,
  ScheduleSummaryDto,
} from "@kiro-ai-bit/contracts";
import type { Db, DbTx } from "@infrastructure/Persistence/db.js";
import {
  createArchivedMedicineRefsRepo,
  createDoseOccurrencesRepo,
  createScheduleExceptionsRepo,
  createSchedulesRepo,
} from "@infrastructure/Persistence/repositories.js";
import type {
  ScheduleExceptionRow,
  ScheduleRow,
} from "@infrastructure/Persistence/schema/index.js";
import type { MedicineOwnership } from "@infrastructure/MedicineClient/getMedicine.js";
import {
  canonicalizeRRule,
  expandRRuleDates,
  isValidDoseTime,
  isValidLocalDate,
  isValidTimeZone,
  parseRRule,
} from "./recurrence.js";
import {
  DependencyError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@core/errors.js";
import type { Metrics } from "@core/metrics.js";
import type { UserClaims } from "@core/types.js";

export interface MaterializeResultShape {
  inserted: number;
  updated: number;
  deleted: number;
  skipped?: "suppressed";
}

export interface MaterializeFn {
  (
    scheduleId: string,
    horizon: { fromDate: string; toDate: string },
    tx: DbTx,
  ): Promise<MaterializeResultShape>;
}

export interface ScheduleDeps {
  db: Db;
  checkLink: (patientId: string, caregiverId: string) => Promise<boolean>;
  // Medicine ownership read — returns null on 404, throws on failure.
  getMedicine: (medicineId: string) => Promise<MedicineOwnership | null>;
  materialize: MaterializeFn;
  horizonDays: number;
  metrics?: Metrics;
}

// §4.3/§8.12 — self (sub == patientId) or linked caregiver via check-link;
// check-link failure → DependencyError (fail-closed deny on caregiver calls).
async function authorizePatientAccess(
  deps: ScheduleDeps,
  patientId: string,
  actor: UserClaims,
): Promise<void> {
  if (actor.sub === patientId) return;
  let active: boolean;
  try {
    active = await deps.checkLink(patientId, actor.sub);
  } catch {
    throw new DependencyError("care check-link unavailable");
  }
  if (!active) throw new ForbiddenError("no active care link");
}

function localToday(tz: string, now: Date): string {
  return DateTime.fromJSDate(now).setZone(tz).toISODate()!;
}

function plusDays(date: string, days: number): string {
  return DateTime.fromISO(date).plus({ days }).toISODate()!;
}

// ---- validation (§8.1) ----------------------------------------------------

interface ValidatedInput {
  recurrenceKind: "rrule" | "date-list";
  rrule: string | null;
  dateList: string[] | null;
  doseTimes: string[];
  timezone: string;
}

function validateCommon(cmd: { doseTimes: string[]; timezone: string }): {
  doseTimes: string[];
  timezone: string;
} {
  const doseTimes = [...new Set(cmd.doseTimes)].sort();
  if (doseTimes.length === 0 || !doseTimes.every(isValidDoseTime)) {
    throw new ValidationError("doseTimes must be >=1 valid HH:MM");
  }
  if (!isValidTimeZone(cmd.timezone)) {
    throw new ValidationError(`invalid timezone: ${cmd.timezone}`);
  }
  return { doseTimes, timezone: cmd.timezone };
}

function validateRecurrence(
  recurrence: CreateScheduleRequest["recurrence"],
): Pick<ValidatedInput, "recurrenceKind" | "rrule" | "dateList"> {
  if (recurrence.kind === "rrule") {
    return {
      recurrenceKind: "rrule",
      rrule: canonicalizeRRule(recurrence.rrule),
      dateList: null,
    };
  }
  const dates = [...new Set(recurrence.dates)].sort();
  if (dates.length === 0 || !dates.every(isValidLocalDate)) {
    throw new ValidationError("date-list requires >=1 valid YYYY-MM-DD dates");
  }
  return { recurrenceKind: "date-list", rrule: null, dateList: dates };
}

interface ExceptionInput {
  date: string;
  kind: "skip" | "time-override";
  time?: string;
}

interface ValidatedException {
  localDate: string;
  kind: "skip" | "time-override";
  overrideTime: string | null;
}

function validateExceptions(
  exceptions: ExceptionInput[] | undefined,
): ValidatedException[] {
  if (!exceptions || exceptions.length === 0) return [];
  const seen = new Set<string>();
  const out: ValidatedException[] = [];
  for (const e of exceptions) {
    if (!isValidLocalDate(e.date)) {
      throw new ValidationError(`invalid exception date: ${e.date}`);
    }
    if (seen.has(e.date)) {
      throw new ValidationError(`duplicate exception date: ${e.date}`);
    }
    seen.add(e.date);
    if (e.kind === "time-override") {
      if (!e.time || !isValidDoseTime(e.time)) {
        throw new ValidationError(
          "time-override exception requires valid HH:MM time",
        );
      }
      out.push({
        localDate: e.date,
        kind: "time-override",
        overrideTime: e.time,
      });
    } else {
      if (e.time !== undefined) {
        throw new ValidationError("skip exception forbids time");
      }
      out.push({ localDate: e.date, kind: "skip", overrideTime: null });
    }
  }
  return out;
}

// §8.1 resolveStartEnd — create only; end<start reject; clamp ≥ local today.
export function resolveStartEnd(
  req: { startDate?: string; endDate?: string | null; timezone: string },
  now: Date,
): { startDate: string; endDate: string | null } {
  const tz = req.timezone;
  const today = localToday(tz, now);
  const requested = req.startDate ?? today;
  if (!isValidLocalDate(requested)) {
    throw new ValidationError(`invalid startDate: ${requested}`);
  }
  const start = requested > today ? requested : today;
  const end = req.endDate ?? null;
  if (end !== null) {
    if (!isValidLocalDate(end)) {
      throw new ValidationError(`invalid endDate: ${end}`);
    }
    if (end < start) {
      throw new ValidationError("endDate must be >= startDate");
    }
  }
  return { startDate: start, endDate: end };
}

// ---- DTO mapping ----------------------------------------------------------

function recurrenceDto(row: ScheduleRow) {
  return row.recurrenceKind === "rrule"
    ? { kind: "rrule" as const, rrule: row.rrule ?? "" }
    : { kind: "date-list" as const, dates: row.dateList ?? [] };
}

function toSummaryDto(
  row: ScheduleRow,
  exceptionCount: number,
): ScheduleSummaryDto {
  return {
    id: row.id,
    patientId: row.patientId,
    medicineId: row.medicineId,
    recurrence: recurrenceDto(row),
    doseTimes: row.doseTimes,
    timezone: row.timezone,
    startDate: row.startDate,
    endDate: row.endDate,
    exceptionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function hhmm(t: string | null): string | null {
  return t ? t.slice(0, 5) : null;
}

async function toDetailDto(
  row: ScheduleRow,
  exceptions: ScheduleExceptionRow[],
): Promise<ScheduleDetailDto> {
  return {
    ...toSummaryDto(row, exceptions.length),
    exceptions: exceptions.map((e) => ({
      date: e.localDate,
      kind: e.kind as "skip" | "time-override",
      timeOverride: hhmm(e.overrideTime),
    })),
    resolvedStartDate: row.startDate,
  };
}

// ---- routes' core ---------------------------------------------------------

export async function listSchedules(
  deps: ScheduleDeps,
  patientId: string,
  actor: UserClaims,
): Promise<{ schedules: ScheduleSummaryDto[] }> {
  await authorizePatientAccess(deps, patientId, actor);
  const schedulesRepo = createSchedulesRepo();
  const exceptionsRepo = createScheduleExceptionsRepo();
  const rows = await schedulesRepo.findByPatient(deps.db, patientId);
  const counts = await exceptionsRepo.countByScheduleIds(
    deps.db,
    rows.map((r) => r.id),
  );
  return {
    schedules: rows.map((row) => toSummaryDto(row, counts.get(row.id) ?? 0)),
  };
}

export async function createSchedule(
  deps: ScheduleDeps,
  patientId: string,
  cmd: CreateScheduleRequest,
  actor: UserClaims,
  now: Date = new Date(),
): Promise<ScheduleDetailDto> {
  await authorizePatientAccess(deps, patientId, actor);

  // Pre-tx peer I/O (HD-SCH-09): medicine ownership read, fail closed.
  let medicine: MedicineOwnership | null;
  try {
    medicine = await deps.getMedicine(cmd.medicineId);
  } catch {
    throw new DependencyError("medicine ownership read unavailable");
  }
  if (!medicine) throw new NotFoundError("medicine not found");
  if (medicine.patientId !== patientId) {
    throw new ForbiddenError("medicine belongs to another patient");
  }

  const common = validateCommon(cmd);
  const rec = validateRecurrence(cmd.recurrence);
  const { startDate, endDate } = resolveStartEnd(
    {
      startDate: cmd.startDate,
      endDate: cmd.endDate ?? null,
      timezone: common.timezone,
    },
    now,
  );
  const exceptions = validateExceptions(cmd.exceptions);

  const schedulesRepo = createSchedulesRepo();
  const exceptionsRepo = createScheduleExceptionsRepo();
  const row = await deps.db.transaction(async (tx) => {
    const inserted = await schedulesRepo.insert(tx, {
      patientId,
      medicineId: cmd.medicineId,
      recurrenceKind: rec.recurrenceKind,
      rrule: rec.rrule,
      dateList: rec.dateList,
      doseTimes: common.doseTimes,
      timezone: common.timezone,
      startDate,
      endDate,
    });
    if (exceptions.length > 0) {
      await exceptionsRepo.replaceAll(
        tx,
        inserted.id,
        exceptions.map((e) => ({
          scheduleId: inserted.id,
          localDate: e.localDate,
          kind: e.kind,
          overrideTime: e.overrideTime,
        })),
      );
    }
    // §6 — synchronous materialization [resolved start … today+90d]
    const horizonTo = plusDays(
      localToday(common.timezone, now),
      deps.horizonDays,
    );
    const from =
      startDate > localToday(common.timezone, now)
        ? startDate
        : localToday(common.timezone, now);
    await deps.materialize(
      inserted.id,
      { fromDate: from, toDate: horizonTo },
      tx,
    );
    return inserted;
  });
  deps.metrics?.incr("schedule_dose_schedules_total", { op: "create" });
  const excRows = await exceptionsRepo.findBySchedule(deps.db, row.id);
  return toDetailDto(row, excRows);
}

export async function getSchedule(
  deps: ScheduleDeps,
  scheduleId: string,
  actor: UserClaims,
): Promise<ScheduleDetailDto> {
  const schedulesRepo = createSchedulesRepo();
  const row = await schedulesRepo.findById(deps.db, scheduleId);
  if (!row) throw new NotFoundError("schedule not found");
  await authorizePatientAccess(deps, row.patientId, actor);
  const exceptionsRepo = createScheduleExceptionsRepo();
  const exc = await exceptionsRepo.findBySchedule(deps.db, row.id);
  return toDetailDto(row, exc);
}

export async function editSchedule(
  deps: ScheduleDeps,
  scheduleId: string,
  patch: SchedulePatchRequest,
  actor: UserClaims,
  now: Date = new Date(),
): Promise<ScheduleDetailDto> {
  const schedulesRepo = createSchedulesRepo();
  const exceptionsRepo = createScheduleExceptionsRepo();
  const row = await schedulesRepo.findById(deps.db, scheduleId);
  if (!row) throw new NotFoundError("schedule not found");
  await authorizePatientAccess(deps, row.patientId, actor);

  if (patch.medicineId !== undefined && patch.medicineId !== row.medicineId) {
    throw new ValidationError("medicineId is immutable");
  }
  const hasMutableField =
    patch.recurrence !== undefined ||
    patch.doseTimes !== undefined ||
    patch.timezone !== undefined ||
    patch.startDate !== undefined ||
    patch.endDate !== undefined ||
    patch.exceptions !== undefined;
  if (!hasMutableField) {
    throw new ValidationError("at least one mutable field required");
  }

  // §8.4 — resolved start is NOT re-clamped; startDate may not move backward.
  const fields: Parameters<typeof schedulesRepo.updateFields>[2] = {};
  let effectiveTz = row.timezone;

  if (patch.timezone !== undefined) {
    if (!isValidTimeZone(patch.timezone)) {
      throw new ValidationError(`invalid timezone: ${patch.timezone}`);
    }
    fields.timezone = patch.timezone;
    effectiveTz = patch.timezone;
  }
  if (patch.doseTimes !== undefined) {
    const { doseTimes } = validateCommon({
      doseTimes: patch.doseTimes,
      timezone: effectiveTz,
    });
    fields.doseTimes = doseTimes;
  }
  if (patch.recurrence !== undefined) {
    const rec = validateRecurrence(patch.recurrence);
    fields.recurrenceKind = rec.recurrenceKind;
    fields.rrule = rec.rrule;
    fields.dateList = rec.dateList;
  }
  if (patch.startDate !== undefined) {
    if (!isValidLocalDate(patch.startDate)) {
      throw new ValidationError(`invalid startDate: ${patch.startDate}`);
    }
    if (patch.startDate < row.startDate) {
      throw new ValidationError("startDate cannot move before resolved start");
    }
    fields.startDate = patch.startDate;
  }
  if (patch.endDate !== undefined) {
    const end = patch.endDate ?? null;
    if (end !== null) {
      if (!isValidLocalDate(end)) {
        throw new ValidationError(`invalid endDate: ${end}`);
      }
      const effectiveStart = fields.startDate ?? row.startDate;
      if (end < effectiveStart) {
        throw new ValidationError("endDate must be >= startDate");
      }
    }
    fields.endDate = end;
  }
  // endDate >= effective startDate across the whole patch (§5.1 CHECK parity)
  const effStart = fields.startDate ?? row.startDate;
  const effEnd = fields.endDate !== undefined ? fields.endDate : row.endDate;
  if (effEnd !== null && effEnd !== undefined && effStart > effEnd) {
    throw new ValidationError("endDate must be >= startDate");
  }
  const exceptionInputs =
    patch.exceptions !== undefined
      ? validateExceptions(patch.exceptions)
      : null;

  const updated = await deps.db.transaction(async (tx) => {
    // updateFields always bumps updated_at — exceptions-only edits count (§5.1)
    const u = await schedulesRepo.updateFields(tx, scheduleId, fields);
    if (!u) throw new NotFoundError("schedule not found");
    if (exceptionInputs !== null) {
      await exceptionsRepo.replaceAll(
        tx,
        scheduleId,
        exceptionInputs.map((e) => ({
          scheduleId,
          localDate: e.localDate,
          kind: e.kind,
          overrideTime: e.overrideTime,
        })),
      );
    }
    // regeneration — future unmarked rows only (§8.4/§8.3 predicate)
    const tz = u.timezone;
    const today = localToday(tz, now);
    await deps.materialize(
      scheduleId,
      { fromDate: today, toDate: plusDays(today, deps.horizonDays) },
      tx,
    );
    return u;
  });
  deps.metrics?.incr("schedule_dose_schedules_total", { op: "edit" });
  const exc = await exceptionsRepo.findBySchedule(deps.db, scheduleId);
  return toDetailDto(updated, exc);
}

// §8.13 — delete schedule + exceptions (cascade) + future unmarked doses;
// history rows retained.
export async function deleteSchedule(
  deps: ScheduleDeps,
  scheduleId: string,
  actor: UserClaims,
  now: Date = new Date(),
): Promise<{ id: string; deleted: true }> {
  const schedulesRepo = createSchedulesRepo();
  const dosesRepo = createDoseOccurrencesRepo();
  const row = await schedulesRepo.findById(deps.db, scheduleId);
  if (!row) throw new NotFoundError("schedule not found");
  await authorizePatientAccess(deps, row.patientId, actor);

  await deps.db.transaction(async (tx) => {
    await schedulesRepo.deleteById(tx, scheduleId);
    await dosesRepo.deleteFutureUnmarked(
      tx,
      scheduleId,
      localToday(row.timezone, now),
    );
  });
  deps.metrics?.incr("schedule_dose_schedules_total", { op: "delete" });
  return { id: scheduleId, deleted: true };
}

// AccountDeleted purge helper (used by ticket-18 consumer wiring).
export async function purgePatientSchedules(
  deps: { db: Db },
  patientId: string,
): Promise<void> {
  const schedulesRepo = createSchedulesRepo();
  const dosesRepo = createDoseOccurrencesRepo();
  const refsRepo = createArchivedMedicineRefsRepo();
  await deps.db.transaction(async (tx) => {
    await dosesRepo.deleteByPatientId(tx, patientId);
    await schedulesRepo.deleteByPatientId(tx, patientId); // cascades exceptions
    await refsRepo.deleteByPatientId(tx, patientId);
  });
}

// Re-export for Application layer (expansion consumes the same parse).
export { parseRRule, expandRRuleDates };
