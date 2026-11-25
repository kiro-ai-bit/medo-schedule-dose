import { DateTime } from "luxon";
import { ValidationError } from "@core/errors.js";

// RRULE subset (LD-SCH-02): FREQ=WEEKLY|MONTHLY|YEARLY + optional INTERVAL=n
// + optional BYDAY (weekly only). Canonical form: sorted KEY=VALUE; pairs.

export type RRuleFreq = "WEEKLY" | "MONTHLY" | "YEARLY";
export interface RRuleSpec {
  freq: RRuleFreq;
  interval: number;
  byday: number[] | null; // luxon weekday 1=Mon..7=Sun, weekly only
}

const WEEKDAY_MAP: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};
const WEEKDAY_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

export function parseRRule(input: string): RRuleSpec {
  const parts = input.split(";").map((p) => p.trim());
  const map = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new ValidationError(`invalid rrule part: ${part}`);
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1).toUpperCase();
    if (map.has(key)) throw new ValidationError(`duplicate rrule key: ${key}`);
    map.set(key, value);
  }
  const freq = map.get("FREQ");
  if (freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    throw new ValidationError(`unsupported FREQ: ${freq ?? "<missing>"}`);
  }
  for (const key of map.keys()) {
    if (!["FREQ", "INTERVAL", "BYDAY"].includes(key)) {
      throw new ValidationError(`unsupported rrule key: ${key}`);
    }
  }
  let interval = 1;
  const intervalRaw = map.get("INTERVAL");
  if (intervalRaw !== undefined) {
    if (!/^\d+$/.test(intervalRaw) || Number(intervalRaw) < 1) {
      throw new ValidationError("INTERVAL must be a positive integer");
    }
    interval = Number(intervalRaw);
  }
  let byday: number[] | null = null;
  const bydayRaw = map.get("BYDAY");
  if (bydayRaw !== undefined) {
    if (freq !== "WEEKLY") {
      throw new ValidationError("BYDAY is only valid with FREQ=WEEKLY");
    }
    const days = bydayRaw.split(",");
    const nums: number[] = [];
    for (const d of days) {
      const n = WEEKDAY_MAP[d];
      if (n === undefined) {
        throw new ValidationError(`invalid BYDAY value: ${d}`);
      }
      if (!nums.includes(n)) nums.push(n);
    }
    byday = nums.sort((a, b) => a - b);
  }
  return { freq, interval, byday };
}

// Canonical storage form — uppercase keys, sorted params, BYDAY in
// MO..SU order deduped (LD-SCH-02).
export function canonicalizeRRule(input: string): string {
  const spec = parseRRule(input);
  const parts = [`FREQ=${spec.freq}`];
  if (spec.interval !== 1) parts.push(`INTERVAL=${spec.interval}`);
  if (spec.byday) {
    const names = WEEKDAY_ORDER.filter((d) =>
      spec.byday!.includes(WEEKDAY_MAP[d]),
    );
    parts.push(`BYDAY=${names.join(",")}`);
  }
  return parts.join(";");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidLocalDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  return DateTime.fromISO(s).isValid;
}

export function isValidDoseTime(s: string): boolean {
  return HHMM_RE.test(s);
}

export function isValidTimeZone(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid && tz.length <= 64;
}

// Generate candidate local dates for an rrule spec within [lo..hi]
// inclusive 'YYYY-MM-DD' bounds. Anchor = startDate (LD-SCH-02/§8.2).
export function expandRRuleDates(
  spec: RRuleSpec,
  anchorDate: string,
  lo: string,
  hi: string,
): string[] {
  const out: string[] = [];
  const anchor = DateTime.fromISO(anchorDate);
  if (lo > hi) return out;

  if (spec.freq === "WEEKLY") {
    const days = spec.byday ?? [anchor.weekday];
    // anchor week = Monday of anchor's week (WKST=MO fixed — explicit, not
    // luxon startOf('week') which is locale-dependent)
    const weekStart = anchor.startOf("day").minus({ days: anchor.weekday - 1 });
    const endCursor = DateTime.fromISO(hi);
    let cursor = weekStart;
    let weekIndex = 0;
    while (cursor <= endCursor) {
      if (weekIndex % spec.interval === 0) {
        for (const wd of days) {
          const d = cursor.plus({ days: wd - 1 }).toISODate()!;
          if (d >= anchorDate && d >= lo && d <= hi) out.push(d);
        }
      }
      cursor = cursor.plus({ weeks: 1 });
      weekIndex += 1;
    }
  } else if (spec.freq === "MONTHLY") {
    const anchorDay = anchor.day;
    let monthCursor = anchor.startOf("month");
    const endCursor = DateTime.fromISO(hi).endOf("month");
    let monthIndex = 0;
    while (monthCursor <= endCursor) {
      if (monthIndex % spec.interval === 0) {
        const dim = monthCursor.daysInMonth ?? 31;
        const day = Math.min(anchorDay, dim);
        const d = monthCursor.set({ day }).toISODate()!;
        if (d >= anchorDate && d >= lo && d <= hi) out.push(d);
      }
      monthCursor = monthCursor.plus({ months: 1 });
      monthIndex += 1;
    }
  } else {
    // YEARLY — Feb 29 → Feb 28 in non-leap years (LD-SCH-02/§8.2)
    const anchorMonth = anchor.month;
    const anchorDay = anchor.day;
    let yearCursor = DateTime.fromISO(`${anchor.year}-01-01`);
    const endCursor = DateTime.fromISO(hi);
    let yearIndex = 0;
    while (yearCursor <= endCursor) {
      if (yearIndex % spec.interval === 0) {
        const dim =
          DateTime.fromObject({
            year: yearCursor.year,
            month: anchorMonth,
          }).daysInMonth ?? 31;
        const day = Math.min(anchorDay, dim);
        const d = DateTime.fromObject({
          year: yearCursor.year,
          month: anchorMonth,
          day,
        }).toISODate()!;
        if (d >= anchorDate && d >= lo && d <= hi) out.push(d);
      }
      yearCursor = yearCursor.plus({ years: 1 });
      yearIndex += 1;
    }
  }
  return out.sort();
}
