import { describe, expect, it } from "vitest";
import {
  canonicalizeRRule,
  expandRRuleDates,
  parseRRule,
} from "@core/Schedule/recurrence.js";
import { expandOccurrences } from "@application/Materialization/expand.js";
import { ValidationError } from "@core/errors.js";
import type {
  ScheduleExceptionRow,
  ScheduleRow,
} from "@infrastructure/Persistence/schema/index.js";

function sched(over: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: "s1",
    patientId: "p1",
    medicineId: "m1",
    recurrenceKind: "rrule",
    rrule: "FREQ=WEEKLY",
    dateList: null,
    doseTimes: ["08:00", "20:00"],
    timezone: "Asia/Karachi",
    startDate: "2026-01-05", // Monday
    endDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ScheduleRow;
}

function exc(over: Partial<ScheduleExceptionRow>): ScheduleExceptionRow {
  return {
    scheduleId: "s1",
    localDate: "2026-01-07",
    kind: "skip",
    overrideTime: null,
    createdAt: new Date(),
    ...over,
  } as ScheduleExceptionRow;
}

describe("parseRRule/canonicalizeRRule", () => {
  it("accepts weekly with BYDAY+INTERVAL and canonicalizes", () => {
    expect(canonicalizeRRule("freq=weekly;byday=we,mo;interval=2")).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
    );
  });
  it("defaults interval=1, omits it", () => {
    expect(canonicalizeRRule("FREQ=MONTHLY")).toBe("FREQ=MONTHLY");
  });
  it("rejects unsupported keys/freq/BYDAY-on-monthly/bad interval", () => {
    expect(() => parseRRule("FREQ=DAILY")).toThrow(ValidationError);
    expect(() => parseRRule("FREQ=WEEKLY;COUNT=5")).toThrow(ValidationError);
    expect(() => parseRRule("FREQ=MONTHLY;BYDAY=MO")).toThrow(ValidationError);
    expect(() => parseRRule("FREQ=WEEKLY;INTERVAL=0")).toThrow(ValidationError);
    expect(() => parseRRule("FREQ=WEEKLY;BYDAY=XX")).toThrow(ValidationError);
  });
});

describe("expandRRuleDates", () => {
  it("weekly BYDAY within horizon", () => {
    const spec = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE");
    const dates = expandRRuleDates(
      spec,
      "2026-01-05",
      "2026-01-05",
      "2026-01-18",
    );
    expect(dates).toEqual([
      "2026-01-05",
      "2026-01-07",
      "2026-01-12",
      "2026-01-14",
    ]);
  });
  it("weekly INTERVAL=2 skips alternate weeks", () => {
    const spec = parseRRule("FREQ=WEEKLY;INTERVAL=2"); // anchor Mon 2026-01-05
    const dates = expandRRuleDates(
      spec,
      "2026-01-05",
      "2026-01-05",
      "2026-02-28",
    );
    expect(dates).toEqual([
      "2026-01-05",
      "2026-01-19",
      "2026-02-02",
      "2026-02-16",
    ]);
  });
  it("monthly clamps month-end (31 → Feb 28)", () => {
    const spec = parseRRule("FREQ=MONTHLY");
    const dates = expandRRuleDates(
      spec,
      "2026-01-31",
      "2026-01-31",
      "2026-04-30",
    );
    expect(dates).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });
  it("yearly Feb-29 → Feb-28 non-leap", () => {
    const spec = parseRRule("FREQ=YEARLY");
    const dates = expandRRuleDates(
      spec,
      "2024-02-29",
      "2024-02-29",
      "2026-12-31",
    );
    expect(dates).toEqual(["2024-02-29", "2025-02-28", "2026-02-28"]);
  });
});

describe("expandOccurrences", () => {
  it("normal slots per dose_time", () => {
    const out = expandOccurrences(sched({}), [], "2026-01-05", "2026-01-11");
    // weekly no BYDAY → anchor weekday (Mon) only → 1 date × 2 slots
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.localDate)).toEqual(["2026-01-05", "2026-01-05"]);
  });
  it("weekly BYDAY=MO,WE,FR expands 3 dates/week", () => {
    const out = expandOccurrences(
      sched({ rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" }),
      [],
      "2026-01-05",
      "2026-01-11",
    );
    expect(out).toHaveLength(6); // 3 dates × 2 times
    expect(out[0]).toMatchObject({
      localDate: "2026-01-05",
      doseTime: "08:00",
      doseSlot: 0,
      skippedByUser: false,
    });
    expect(out[1].doseSlot).toBe(1);
    expect(out[1].doseTime).toBe("20:00");
  });
  it("skip exception flags all slots skippedByUser", () => {
    const out = expandOccurrences(
      sched({ rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" }),
      [exc({ localDate: "2026-01-07" })],
      "2026-01-05",
      "2026-01-11",
    );
    const wed = out.filter((o) => o.localDate === "2026-01-07");
    expect(wed).toHaveLength(2);
    expect(wed.every((o) => o.skippedByUser)).toBe(true);
  });
  it("time-override replaces slot set with single slot-0 dose", () => {
    const out = expandOccurrences(
      sched({ rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" }),
      [
        exc({
          kind: "time-override",
          localDate: "2026-01-07",
          overrideTime: "10:30:00",
        }),
      ],
      "2026-01-05",
      "2026-01-11",
    );
    const wed = out.filter((o) => o.localDate === "2026-01-07");
    expect(wed).toHaveLength(1);
    expect(wed[0]).toMatchObject({
      doseTime: "10:30",
      doseSlot: 0,
      skippedByUser: false,
    });
  });
  it("date-list recurrence intersects horizon", () => {
    const out = expandOccurrences(
      sched({
        recurrenceKind: "date-list",
        rrule: null,
        dateList: ["2026-01-06", "2026-01-20", "2026-02-01"],
      }),
      [],
      "2026-01-05",
      "2026-01-31",
    );
    expect(out.map((o) => o.localDate)).toEqual([
      "2026-01-06",
      "2026-01-06",
      "2026-01-20",
      "2026-01-20",
    ]);
  });
  it("respects endDate bound", () => {
    const out = expandOccurrences(
      sched({ endDate: "2026-01-07" }),
      [],
      "2026-01-05",
      "2026-02-28",
    );
    expect(out.every((o) => o.localDate <= "2026-01-07")).toBe(true);
  });
  it("DST gap resolves to a deterministic instant (luxon)", () => {
    const out = expandOccurrences(
      sched({
        timezone: "America/New_York",
        startDate: "2026-03-08",
        rrule: "FREQ=WEEKLY",
        doseTimes: ["02:30"],
      }),
      [],
      "2026-03-08",
      "2026-03-14",
    );
    expect(out).toHaveLength(1);
    // 2026-03-08 02:30 NY = spring-forward gap → luxon shifts forward
    expect(out[0].scheduledAt.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
  it("DST overlap resolves deterministically (luxon earlier-offset)", () => {
    const out = expandOccurrences(
      sched({
        timezone: "America/New_York",
        startDate: "2026-10-25",
        rrule: "FREQ=WEEKLY",
        doseTimes: ["01:30"],
      }),
      [],
      "2026-10-25",
      "2026-11-01",
    );
    const nov1 = out.find((o) => o.localDate === "2026-11-01");
    expect(nov1).toBeTruthy();
    // 2026-11-01 01:30 NY is ambiguous (EDT→EST). Luxon picks the earlier
    // offset occurrence → EDT (UTC-4) → 05:30Z. Deterministic across runs.
    expect(nov1!.scheduledAt.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    // run twice → identical (deterministic)
    const out2 = expandOccurrences(
      sched({
        timezone: "America/New_York",
        startDate: "2026-10-25",
        rrule: "FREQ=WEEKLY",
        doseTimes: ["01:30"],
      }),
      [],
      "2026-10-25",
      "2026-11-01",
    );
    expect(out2.find((o) => o.localDate === "2026-11-01")!.scheduledAt).toEqual(
      nov1!.scheduledAt,
    );
  });
});
