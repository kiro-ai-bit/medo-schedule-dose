import { expandRRuleDates, parseRRule } from "@core/Schedule/recurrence.js";
import { resolveLocalInstant } from "@core/Schedule/localTime.js";
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
