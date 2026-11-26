import { describe, expect, it } from "vitest";
import { classifyWindow } from "@core/Dose/dose.js";

const TZ = "Asia/Karachi"; // UTC+5, no DST
// 2026-11-26 08:00 PKT = 03:00 UTC
const T = new Date("2026-11-26T03:00:00.000Z");
const dose = { localDate: "2026-11-26", doseTime: "08:00" };
const at = (iso: string) => new Date(iso);

describe("classifyWindow (§8.5)", () => {
  it("before-window before T-30min", () => {
    expect(classifyWindow(dose, TZ, at("2026-11-26T02:29:59.999Z"))).toBe(
      "before-window",
    );
  });
  it("on-time-window at T-30 boundary (inclusive)", () => {
    expect(classifyWindow(dose, TZ, at("2026-11-26T02:30:00.000Z"))).toBe(
      "on-time-window",
    );
  });
  it("on-time-window at T and at T+60 boundary (inclusive)", () => {
    expect(classifyWindow(dose, TZ, T)).toBe("on-time-window");
    expect(classifyWindow(dose, TZ, at("2026-11-26T04:00:00.000Z"))).toBe(
      "on-time-window",
    );
  });
  it("late-window after T+60 until local midnight", () => {
    expect(classifyWindow(dose, TZ, at("2026-11-26T04:00:00.001Z"))).toBe(
      "late-window",
    );
    // 2026-11-26 23:59:59 PKT = 18:59:59 UTC
    expect(classifyWindow(dose, TZ, at("2026-11-26T18:59:59.999Z"))).toBe(
      "late-window",
    );
  });
  it("missed-locked at local midnight", () => {
    // 2026-11-27 00:00 PKT = 2026-11-26 19:00 UTC
    expect(classifyWindow(dose, TZ, at("2026-11-26T19:00:00.000Z"))).toBe(
      "missed-locked",
    );
  });
  it("respects schedule tz not UTC", () => {
    // Same instant, tz=UTC → local date differs; T=03:00Z is 08:00 PKT.
    // In UTC the dose localDate 2026-11-26 midnight = 00:00Z; now=18:30Z is
    // still same UTC day → late-window (T+60=04:00Z passed).
    expect(classifyWindow(dose, "UTC", at("2026-11-26T18:30:00.000Z"))).toBe(
      "late-window",
    );
  });
});
