import { DateTime, IANAZone } from "luxon";
import { expandRRuleDates, parseRRule } from "@core/Schedule/recurrence.js";
import type {
  ScheduleExceptionRow,
  ScheduleRow,
} from "@infrastructure/Persistence/schema/index.js";

// §8.2 — occurrence expansion. All math in schedule.timezone via luxon
// (LD-SCH-12): gap → luxon forward-shift; overlap → earlier offset.

export interface OccurrenceSpec {
  localDate: string;
  doseTime: string;
  doseSlot: number;
  scheduledAt: Date;
  skippedByUser: boolean;
}

// LD-SCH-12 — deterministic local→instant: spring-forward gap → luxon
// forward-shift; fall-back overlap → EARLIER-offset (first) occurrence.
// Luxon's default picks the later occurrence for ambiguous times, so we
// resolve candidates explicitly.
export function resolveLocalInstant(
  localDate: string,
  doseTime: string,
  tz: string,
): Date {
  const iso = `${localDate}T${doseTime}:00`;
  const zone = IANAZone.create(tz);
  if (!zone.isValid) {
    return DateTime.fromISO(iso, { zone: tz }).toJSDate();
  }
  const localMillis = DateTime.fromISO(iso, { zone: "utc" }).toMillis();
  // offsets in effect within ±48h of the local time (covers any DST delta)
  const offsets = new Set<number>();
  for (let h = -48; h <= 48; h += 1) {
    offsets.add(zone.offset(localMillis + h * 3_600_000));
  }
  const candidates: number[] = [];
  for (const offMin of offsets) {
    const ts = localMillis - offMin * 60_000;
    if (zone.offset(ts) === offMin) {
      const back = DateTime.fromMillis(ts, { zone: tz });
      if (back.toFormat("yyyy-MM-dd'T'HH:mm:ss") === iso) candidates.push(ts);
    }
  }
  if (candidates.length === 0) {
    // gap — luxon deterministic forward-shift
    return DateTime.fromISO(iso, { zone: tz }).toJSDate();
  }
  // ambiguous → earliest UTC instant (= earlier-offset occurrence)
  return new Date(Math.min(...candidates));
}

export function expandOccurrences(
  schedule: ScheduleRow,
  exceptions: ScheduleExceptionRow[],
  fromDate: string,
  toDate: string,
): OccurrenceSpec[] {
  const lo = schedule.startDate > fromDate ? schedule.startDate : fromDate;
  const hiEnd = schedule.endDate ?? "9999-12-31";
  const hi = hiEnd < toDate ? hiEnd : toDate;
  if (lo > hi) return [];

  let candidates: string[];
  if (schedule.recurrenceKind === "date-list") {
    candidates = (schedule.dateList ?? []).filter((d) => d >= lo && d <= hi);
  } else {
    const spec = parseRRule(schedule.rrule ?? "");
    candidates = expandRRuleDates(spec, schedule.startDate, lo, hi);
  }

  const excByDate = new Map(exceptions.map((e) => [e.localDate, e]));
  const out: OccurrenceSpec[] = [];
  for (const localDate of candidates) {
    const exc = excByDate.get(localDate);
    if (exc?.kind === "time-override") {
      const t = (exc.overrideTime ?? "").slice(0, 5);
      out.push({
        localDate,
        doseTime: t,
        doseSlot: 0,
        scheduledAt: resolveLocalInstant(localDate, t, schedule.timezone),
        skippedByUser: false,
      });
      continue;
    }
    const skipped = exc?.kind === "skip";
    schedule.doseTimes.forEach((t, i) => {
      out.push({
        localDate,
        doseTime: t,
        doseSlot: i,
        scheduledAt: resolveLocalInstant(localDate, t, schedule.timezone),
        skippedByUser: skipped,
      });
    });
  }
  return out;
}
