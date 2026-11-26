import { DateTime, IANAZone } from "luxon";

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
