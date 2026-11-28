---
prd_id: PRD-MEDO-SCHEDULE-DOSE-001
title: Schedule & Dose Service — Schedules, materialized Dose rows, and outcome lifecycle
application: Medo
component: "Schedule & Dose"
profile: backend-microservice
version: "1.0"
status: approved
author: Devin
approver: Sir Asim
approval_date: 22-11-26 05-08-28 UTC
upstream:
  feature_list: docs/features/feature-list.md@2026-11-20
  service_catalog: docs/contracts/service-catalog.md@2026-11-22
  glossary: GLOSSARY.md@2026-11-21
  architecture_standard: docs/architecture/MicroservicesApps-Architecture-Standard.md
downstream: [HLD, LLD, tasks]
hld_readiness: pass
supersedes: none
superseded_by: null
---

# PRD-MEDO-SCHEDULE-DOSE-001: Schedule & Dose Service — Schedules, materialized Dose rows, and outcome lifecycle

## 1. Problem statement

Schedule & Dose is Medo's volatile core: it turns a **Schedule** (a recurring dose plan on one private **Medicine** record) into materialized **Dose** rows, classifies every outcome (taken-on-time / taken-late / skipped / missed), and publishes `DoseOutcomeChanged` on every change. Three downstream services depend on its truth: Medicine applies Doses Remaining deltas, Gamification recomputes Harmony Points and theme state, and Notification polls `GET /v1/doses/due` to fire reminders and the email fallback.

Current state: none — greenfield build; there is no workaround in production. The cost of getting this wrong is systemic: a missed-lock bug silently locks or unlocks doses; a generation gap produces no reminders; a wrong classification corrupts points and refill counts simultaneously; a due-poll leak spams patients or caregivers.

Quantification: dose events <5,000/day and <50 concurrent users (`platform-quality-baseline.md`). The binding constraint is temporal correctness — per-schedule timezone math, midnight missed-lock precision (≤60 s), edit-until-midnight semantics, and idempotent materialization — not throughput.

Trace: `docs/features/feature-list.md` §§5, 6, 9, 10 (scheduling, reminders, channels, gamification inputs), Map 1 tickets 05/06/10, Map 2 ticket 04, Map 3 tickets 07/09, Map 4 tickets 01/02.

## 2. Goals and non-goals

### 2.1 Goals

- G-1: A Patient or linked Caregiver can create, read, edit, and delete Schedules via the guided-builder contract (RRULE or explicit date list + dose times + schedule-owned timezone + optional start/end + per-occurrence exceptions). [§1]
- G-2: Every active Schedule materializes Dose rows across a rolling 90-day horizon (schedule-local today → today+90d), extended nightly and regenerated synchronously on schedule writes, so reminders, missed-lock, and history always have rows to work on. [§1]
- G-3: Dose rows follow the fixed window lifecycle — takeable T−30min, on-time until T+1hr, late until schedule-local midnight, missed-locked after — with server-side outcome classification and edit-until-midnight. [§1]
- G-4: `DoseOutcomeChanged` is published on EVERY outcome change (marks, edits, missed-lock) with minimal payload, so Medicine and Gamification stay truthful in real time. [§1]
- G-5: Pull read APIs serve the frontend Today/shared-caregiver views, Notification's per-minute due-poll, Medicine's delete guard, and Gamification's bootstrap — all under correct authz. [§1]
- G-6: `AccountDeleted` purges all of a user's Schedules and Dose rows; `MedicineArchived` stops dose generation for that medicine's schedules while retaining existing rows as history. [§1]

### 2.2 Non-goals

- NG-1: Medicine catalog/records, photos, Doses Remaining arithmetic, refill alerts — owned by Medicine Service (Map 2 ticket 03/07); this service only supplies dose outcomes and the `has-dose-records` answer.
- NG-2: Reminder delivery (Web Push, email fallback, in-app feed), reminder policy/timing windows beyond exposing due-state, push subscriptions — owned by Notification Service (Map 2 ticket 05).
- NG-3: Harmony Points / theme computation — owned by Gamification Service; this service only publishes outcome classifications.
- NG-4: User accounts, profiles, timezones — owned by Identity Service; Schedule stores its own timezone captured at build time (Map 2 ticket 04).
- NG-5: Care Link state — owned by Care Service; this service only consumes `check-link` answers per request.
- NG-6: The guided-builder UI itself, calendar rendering, Today screen — owned by the combined frontend PRD; this service owns the stored contract shape only.
- NG-7: Snooze duration policy and re-ping rhythm — Notification/frontend concern; this service stores only the transient `snoozedUntil` field.
- NG-8: Historical backfill of doses before app adoption or before a schedule's start — v1 materializes forward only.
- NG-9: HLD/LLD/implementation — downstream artifacts per Architecture Standard.

## 3. Users, actors, and roles

| Actor | Role (glossary term) | Acts on behalf of | Authz requirement summary |
|---|---|---|---|
| Patient | Patient | self | Full schedule CRUD + dose outcome/snooze on own `patientId` (= own userId) |
| Caregiver | Caregiver | linked Patient | Same parity per linked patient via Care `check-link` per request (Map 1 t03) |
| Notification service | Medo service | Medo platform | Internal `GET /v1/doses/due?window=` poll every minute; service-JWT only |
| Gamification service | Medo service | Medo platform | Internal read of `GET /v1/patients/{id}/doses` + `GET /v1/doses/{id}` for pull-bootstrap; service-JWT only |
| Medicine service | Medo service | Medo platform | Internal `GET /v1/patients/{id}/has-dose-records` for the delete guard; service-JWT only |
| Medicine service | upstream provider | Medo platform | Publishes `MedicineArchived` consumed here; consumes `DoseOutcomeChanged` downstream of this service |
| Identity service | upstream provider | Medo platform | Publishes `AccountDeleted` consumed here |
| System | embedded jobs | Medo platform | `dose-generation` (daily 03:00 UTC) + `missed-lock-tick` (per minute) per `scheduled-jobs.md` |

## 4. User stories / capability inventory

Service-scoped stories (backend profile §4):

- US-SD-01: As a Patient or linked Caregiver, I want to build a Schedule (dates/RRULE + dose times + timezone + start/end) so that my medicines recur without daily re-entry. [FR-SD-001…005]
- US-SD-02: As the platform, I want Dose rows materialized across a rolling 90-day horizon so that reminders, missed-lock, and history always have occurrences to act on. [FR-SD-007…009]
- US-SD-03: As a Patient or linked Caregiver, I want to mark a dose taken or skipped, and edit the outcome until midnight, so that my record reflects reality. [FR-SD-011…013]
- US-SD-04: As the platform, I want missed doses locked automatically at schedule-local midnight so that late marking and points penalties are deterministic. [FR-SD-013]
- US-SD-05: As the platform, I want `DoseOutcomeChanged` on every outcome change so that Medicine and Gamification recompute immediately. [FR-SD-020]
- US-SD-06: As Notification, I want a due-poll answering which doses need reminders now so that I never store dose state. [FR-SD-018]
- US-SD-07: As Medicine, I want a synchronous has-dose-records answer so that I can guard medicine deletion fail-closed. [FR-SD-019]
- US-SD-08: As the platform, I want account deletion to purge schedules and doses, and medicine archival to stop generation, so that health data never outlives its owner or a retired medicine. [FR-SD-009, 021, 022]

## 5. Functional requirements

### 5.1 Schedule CRUD & recurrence contract

- FR-SD-001: WHEN `POST /v1/patients/{id}/schedules` is called under patient-self or linked-caregiver authz with a guided-builder payload, the Schedule & Dose service SHALL persist a Schedule referencing an existing private Medicine record of that patient (`medicineId`), storing: recurrence as RFC 5545 RRULE (freq ∈ none-as-explicit-date-list / weekly / monthly / yearly) or an explicit date list for scattered one-offs, a fixed set of dose times per day, an IANA timezone captured at build time, resolved start date (default: schedule-local today) and resolved end date (default: never), and an empty exception set. [US-SD-01]
  - AC-SD-001a: response returns the created Schedule with resolved start/end — the effective defaults are stored, not implied — verification: contract test.
  - AC-SD-001b: (negative) `medicineId` belonging to another patient or nonexistent → rejected — verification: contract test.
  - AC-SD-001c: (negative) invalid timezone, empty dose-time set, end before start, or out-of-range time value → rejected — verification: contract test.
- FR-SD-002: WHEN `GET /v1/patients/{id}/schedules` is called under the same authz, the service SHALL return that patient's Schedules including recurrence definition, dose times, timezone, resolved start/end, and exception summary. [US-SD-01]
  - AC-SD-002a: (negative) cross-patient or unlinked-caregiver call denied — verification: contract test (Care stubbed).
- FR-SD-003: WHEN `GET /v1/schedules/{id}` is called under the same authz, the service SHALL return the Schedule detail sufficient to render the guided builder: stored RRULE/date list, dose times, timezone, start/end, and all exceptions. [US-SD-01]
  - AC-SD-003a: unknown id → not-found — verification: contract test.
- FR-SD-004: WHEN `PATCH /v1/schedules/{id}` is called under the same authz, the service SHALL apply field changes and/or per-occurrence exceptions, then SHALL regenerate future unmarked Dose rows so the materialized set reflects the new recurrence/exceptions; Dose rows already carrying an outcome, snooze, or mark SHALL NOT be altered. [US-SD-01, US-SD-02]
  - AC-SD-004a: changing dose time shifts future unmarked rows' scheduled times; marked rows keep original time — verification: integration test.
  - AC-SD-004b: adding a skip exception marks the matching future occurrence `skippedByUser` instead of a live dose — verification: integration test.
  - AC-SD-004c: (negative) edits on a schedule whose patient link is inactive → denied — verification: contract test.
- FR-SD-005: WHEN `DELETE /v1/schedules/{id}` is called under the same authz, the service SHALL remove the Schedule and SHALL remove its future unmarked Dose rows while retaining every Dose row that has history (any outcome, mark, or `skippedByUser` flag) as read-only history. [US-SD-01]
  - AC-SD-005a: after delete, list/detail return not-found; dose history for the patient remains queryable — verification: integration test.
  - AC-SD-005b: repeat delete → not-found, no partial state — verification: contract test.
- FR-SD-006: The service SHALL represent per-occurrence exceptions inside the Schedule as EXDATE-style skips and per-date time overrides; a skipped occurrence SHALL materialize as a Dose row flagged `skippedByUser` (plan-level skip — history only, no reminders, no outcome, no points, no Doses Remaining effect) and SHALL NEVER be conflated with the dose-level `skipped` outcome. [US-SD-01]
  - AC-SD-006a: `skippedByUser` rows are excluded from `GET /v1/doses/due` and never emit `DoseOutcomeChanged` — verification: integration test.
  - AC-SD-006b: time-override changes that occurrence's scheduled time and therefore its window classification — verification: unit test.

### 5.2 Dose materialization & generation jobs

- FR-SD-007: The service SHALL materialize Dose rows for every active Schedule covering schedule-local occurrences from today through today+90 days, one row per (schedule, occurrence date, dose time); materialization SHALL be idempotent — re-running generation upserts by occurrence identity and never duplicates or overwrites rows carrying state. [US-SD-02]
  - AC-SD-007a: `dose-generation` job re-run produces zero new/changed rows when nothing changed — verification: integration test.
  - AC-SD-007b: occurrences before schedule-local today are never materialized — verification: unit test.
- FR-SD-008: Initial materialization SHALL run synchronously inside `POST`/`PATCH /v1/patients/{id}/schedules` so a created/edited schedule has its dose rows before the response returns; the daily `dose-generation` job (03:00 UTC) extends only the rolling horizon edge per `scheduled-jobs.md`. [US-SD-02]
  - AC-SD-008a: create response is followed by immediately queryable dose rows — verification: integration test.
- FR-SD-009: WHEN the service consumes `MedicineArchived` `{medicineId, patientId}`, it SHALL stop dose generation for every Schedule of that patient referencing that medicine — no new Dose rows beyond the current materialized horizon — SHALL retain all existing Dose rows unchanged as history, and SHALL exclude that medicine's unmarked future Dose rows from `GET /v1/doses/due` responses so no reminders fire for an archived medicine; redelivery SHALL be a no-op. [US-SD-08]
  - AC-SD-009a: after consumption, `dose-generation` produces no new rows for that medicine's schedules — verification: integration test.
  - AC-SD-009b: after consumption, unmarked future doses of that medicine are absent from every `/v1/doses/due` window while remaining queryable via the patient doses read — verification: integration test.
  - AC-SD-009c: (negative) `MedicineArchived` for an unknown medicineId/patientId → no-op, not an error — verification: integration test.
  - AC-SD-009d: consumption is idempotent — verification: integration test.

### 5.3 Dose windows, outcomes & missed-lock

- FR-SD-010: The service SHALL evaluate every Dose row against fixed windows in the Schedule's stored timezone: takeable from T−30min; on-time until T+1hr; late until schedule-local midnight; unmarked after schedule-local midnight = missed and locked. All boundary comparisons SHALL use the schedule timezone, never the user's profile timezone or server UTC date. [US-SD-03, US-SD-04]
  - AC-SD-010a: a dose at 08:00 schedule-tz is takeable from 07:30, on-time until 09:00, late until local midnight — verification: unit test (tz matrix incl. non-UTC tz).
  - AC-SD-010b: (negative) marking before T−30min or after the missed-lock is rejected — verification: contract test.
- FR-SD-011: WHEN `POST /v1/doses/{id}/outcome` is called under patient-self or linked-caregiver authz with `{taken-on-time|taken-late|skipped}`, the service SHALL record the outcome with acting-identity attribution (`actorId`) and SHALL publish `DoseOutcomeChanged`; the service SHALL derive on-time vs late classification authoritatively from the mark timestamp — a client-supplied taken-on-time/taken-late that contradicts the current window SHALL be rejected. `missed` is system-set only and SHALL NOT be accepted from clients. [US-SD-03]
  - AC-SD-011a: mark within on-time window stores `taken-on-time`; mark in late window stores `taken-late` — verification: integration test.
  - AC-SD-011b: (negative) `taken-on-time` submitted while only the late window is open → rejected — verification: contract test.
  - AC-SD-011c: (negative) client-submitted `missed` → rejected — verification: contract test.
  - AC-SD-011d: response/event carry `actorId` distinguishing Patient vs Caregiver marks — verification: contract test.
- FR-SD-012: The service SHALL allow outcome changes on a Dose row at any time before its missed-lock, including taken↔skipped and on-time↔late transitions; EVERY change SHALL emit `DoseOutcomeChanged` carrying the new outcome so downstream deltas follow current state. [US-SD-03, US-SD-05]
  - AC-SD-012a: taken→skipped edit emits a second event with `skipped`; taken→taken-late reclassification emits with new outcome — verification: integration test.
  - AC-SD-012b: (negative) outcome change after missed-lock → rejected — verification: contract test.
- FR-SD-013: The `missed-lock-tick` job SHALL run every minute; for each active Schedule it SHALL detect schedule-local date advance and SHALL set every still-unmarked Dose row of the prior local day to outcome `missed` (locked, immutable) and emit `DoseOutcomeChanged` per dose; precision SHALL be ≤60 s after schedule-local midnight. Snoozed doses SHALL still lock — snooze never extends the lock. [US-SD-04]
  - AC-SD-013a: unmarked dose locks within one tick of local midnight and emits exactly one `DoseOutcomeChanged{outcome: missed}` — verification: integration test (fake clock).
  - AC-SD-013b: job re-run / overlapping ticks never double-emit for the same dose — verification: integration test.
  - AC-SD-013c: (negative) a dose marked in the final seconds before lock keeps its outcome — verification: integration test (race fixture).
- FR-SD-014: WHEN `POST /v1/doses/{id}/snooze` is called under the same authz, the service SHALL set the transient `snoozedUntil` field (now + 5 min) on the Dose row, SHALL NOT emit any event, and SHALL leave outcome/points/Doses-Remaining unaffected; snooze SHALL be settable on unmarked doses only and SHALL NOT prevent missed-lock. [US-SD-03]
  - AC-SD-014a: snoozed dose excluded from `GET /v1/doses/due` while `now < snoozedUntil`, included again after — verification: integration test.
  - AC-SD-014b: (negative) snooze on locked/missed or outcome-marked dose → rejected — verification: contract test.
- FR-SD-015: Concurrent marks on the same Dose row by different authorized actors (Patient + Caregiver, or two caregivers) SHALL resolve last-write-wins per the platform idempotency rule; the stored outcome and emitted event SHALL reflect the final write, and attribution SHALL record the last actor. [US-SD-03]
  - AC-SD-015a: two sequential outcome writes → second wins, two events emitted in order — verification: integration test.

### 5.4 Pull read APIs

- FR-SD-016: WHEN `GET /v1/patients/{id}/doses?from=&to=&outcome=` is called, the service SHALL return the patient's Dose rows in the window filtered by outcome/state, each with scheduled time, current outcome or unmarked state, `skippedByUser` flag, `snoozedUntil`, and medicine linkage — under dual authz: patient-self / linked caregiver (public) OR Medo service token (internal, e.g. Gamification pull-bootstrap). [US-SD-06]
  - AC-SD-016a: (negative) user token on internal intent and service token on patient-scoped intent handled per FR-SD-023 — verification: contract test.
  - AC-SD-016b: response is a DTO — no internal fields — verification: contract test.
- FR-SD-017: WHEN `GET /v1/doses/{id}` is called under the same dual authz, the service SHALL return the Dose detail (schedule linkage, scheduled time, window state, outcome, actor attribution, snooze flag). [US-SD-06]
  - AC-SD-017a: unknown id → not-found — verification: contract test.
- FR-SD-018: WHEN `GET /v1/doses/due?window=` is called under Medo-service authz only, the service SHALL return the doses currently inside the requested reminder window class (T−30 / T / T+1hr / hourly / midnight missed-lock) with the fields Notification needs to compose reminders (doseId, medicineId, patientId, scheduled time, current state), SHALL exclude rows with `skippedByUser`, rows where `now < snoozedUntil`, and unmarked future rows of `MedicineArchived`-suppressed medicines (FR-SD-009), and SHALL return missed-locked doses under the midnight window for the missed ping. [US-SD-06]
  - AC-SD-018a: (negative) user session token → rejected (internal route) — verification: contract test.
  - AC-SD-018b: snoozed and plan-skipped rows absent from every window — verification: integration test.
  - AC-SD-018c: p95 < 200 ms under per-minute polling — verification: load test vs NFR-SD-01.
- FR-SD-019: WHEN `GET /v1/patients/{id}/has-dose-records` is called under Medo-service authz only, the service SHALL return whether the patient has ≥1 Dose row in any state (unmarked, any outcome, `skippedByUser`, missed) — the synchronous answer Medicine's delete guard requires; the answer SHALL be current (no cache). [US-SD-07]
  - AC-SD-019a: patient with only `skippedByUser` rows still returns true — verification: integration test.
  - AC-SD-019b: (negative) user session token → rejected — verification: contract test.

### 5.5 Events, deletion & authz

- FR-SD-020: The service SHALL publish `DoseOutcomeChanged` on EVERY outcome change — client marks, outcome edits, and missed-lock transitions — with payload `{doseId, medicineId, patientId, outcome, actorId?, occurredAt}` in the `{eventId, occurredAt}` envelope; `outcome` ∈ `taken-on-time | taken-late | skipped | missed`; payloads carry IDs + changed fields only. Delivery is at-least-once via the per-service outbox; consumers (Medicine, Gamification) own idempotency. [US-SD-05]
  - AC-SD-020a: mark + subsequent edit produces two events in order — verification: contract test.
  - AC-SD-020b: missed-lock emits one event per locked dose — verification: integration test.
  - AC-SD-020c: event write shares the outcome-write transaction (outbox pattern) — no outcome without its event — verification: integration test.
- FR-SD-021: WHEN the service consumes `AccountDeleted` `{userId}`, it SHALL purge all Schedules and Dose rows belonging to that user and SHALL emit no further events for them; redelivery SHALL be a no-op. [US-SD-08]
  - AC-SD-021a: post-purge, all patient-scoped reads return empty/not-found — verification: integration test.
  - AC-SD-021b: consumption idempotent — verification: integration test.
- FR-SD-022: The service SHALL authorize every patient-scoped route server-side per request: patient-self when `patientId` = session `sub`, else Care `check-link?patientId=&caregiverId=` for caregiver sessions; internal-only routes (`/doses/due`, `has-dose-records`) SHALL require a Medo service JWT and SHALL reject user tokens; the frontend is never trusted for authz. [US-SD-01, 03, 06, 07]
  - AC-SD-022a: caregiver with active link gets full parity; without link → denied — verification: contract test (Care stubbed).
  - AC-SD-022b: check-link failure/timeout → deny (fail closed); the ~15 s positive consumer cache (Map 3 t09) is the only grace window — verification: integration test.
  - AC-SD-022c: (negative) service token on patient-scoped route and user token on internal route both rejected — verification: contract test.

## 6. Non-functional requirements

| NFR-ID | Category | Metric + threshold + condition | Source/justification |
|---|---|---|---|
| NFR-SD-01 | performance/latency | Public reads (`GET /v1/patients/{id}/schedules`, `/doses`, `/schedules/{id}`, `/doses/{id}`) p95 < 300 ms; public writes (schedule CRUD, outcome, snooze) p95 < 500 ms; internal routes (`/v1/doses/due`, `has-dose-records`, internal doses reads) p95 < 200 ms — `/doses/due` is polled every minute and must stay cheap | `platform-quality-baseline.md` route classes |
| NFR-SD-02 | availability/reliability | ~99% during hackathon period; dependency failure returns clean 4xx/5xx JSON, never crash/hang; own-DB failure → 503; missed-lock/due-poll correctness degrades to next-tick retry, never silent skip | `platform-quality-baseline.md` |
| NFR-SD-03 | scalability | < 50 concurrent users; < 5,000 dose events/day; materialized rows bounded by schedules × 90-day horizon (tens of thousands — single-table scans acceptable); single instance on EC2 `t3.micro`; per-minute tick + daily batch are the only background load | `platform-quality-baseline.md` load envelope |
| NFR-SD-04 | security/authz | Patient-scoped routes session-gated + `check-link` per request; internal routes service-JWT (`aud`-scoped) only; acting-identity attribution on every outcome; per-route rate limits per Map 3 t09 (public 30/min/IP, auth'd writes 60/min/userId, reads 300/min/user); internal service-JWT routes exempt | Map 2 t04, Map 3 t06/09 |
| NFR-SD-05 | data/privacy | Dose times, outcomes, and medicine linkage = health-adjacent PII; all Schedules + Dose rows purged on `AccountDeleted`; archived-medicine dose rows retained as history by design; no backups in v1 (accepted risk) | `platform-quality-baseline.md` retention table |
| NFR-SD-06 | observability | Pino JSON logs + `X-Request-Id`/`eventId` correlation; `GET /metrics` RED + custom counters (schedules created/edited/deleted, dose rows generated/locked, outcome marks/edits, snoozes, `DoseOutcomeChanged` published, `MedicineArchived`/`AccountDeleted` consumed, `/doses/due` poll count+latency, job run success/fail for both jobs); Sentry project `medo-schedule-dose`; `/health` public, `/ready` checks own DB + `broker_db` | `platform-observability.md` + PRD deltas |

† Offline/resilience and accessibility NFR categories are frontend-profile only — not applicable to this backend PRD.

### 6.1 Scaling & operational needs

- Load profile: `/doses/due` is the hottest route — one call/minute per Notification instance plus frontend dose-window reads; both are indexed lookups over materialized rows. `missed-lock-tick` scans active Schedules once/minute (small set); `dose-generation` is a nightly batch over the rolling edge. All volumes sit far below the platform envelope.
- Scheduled jobs (cite `scheduled-jobs.md`, no deltas): `dose-generation` daily `03:00 UTC` — extend materialized rows to rolling today+90d per schedule tz; `missed-lock-tick` every minute — schedule-local date advance → lock prior-day unmarked doses + emit `DoseOutcomeChanged`. Both stateless ticks: failure = log + Sentry + next-tick retry.
- Statefulness: Schedules, Dose rows, exceptions, and the outbox live in own `schedule_dose_db`; rate-limit counters in-memory per Map 3 t09; check-link positive cache ~15 s consumer-side per Map 3 t09.
- Health: `GET /health` public liveness; `GET /ready` internal readiness checking own Postgres DB + `broker_db` reachability (publisher + two event consumers).
- Deployment independence: independently containerized per Architecture Standard; runtime couplings are Care `check-link`, `broker_db` event transport, and synchronous answers to Medicine (`has-dose-records`) — all declared in §10/§11.

## 7. Scope boundaries

### 7.1 In scope

- Schedule CRUD: guided-builder contract (RRULE/date-list + dose times + schedule tz + resolved start/end) + per-occurrence skip/time-override exceptions.
- Materialized Dose rows: synchronous initial materialization + rolling 90-day generation job + regeneration on schedule writes.
- Dose window lifecycle: takeable/on-time/late/missed classification in schedule timezone; outcome marking + edit-until-midnight; missed-lock job; transient snooze.
- `skippedByUser` plan-skip flag kept strictly distinct from dose-level `skipped` outcome.
- Pull reads: patient dose windows, dose detail, `/doses/due` reminder poll, `has-dose-records` guard — dual/public + internal authz.
- `DoseOutcomeChanged` publication on every change; `AccountDeleted` + `MedicineArchived` consumption.
- Patient-self vs linked-caregiver authz via Care `check-link`; service-JWT internal routes.

### 7.2 Out of scope

- Medicine records/catalog/photos/Doses Remaining/refill alerts — Medicine Service.
- Reminder composition/delivery, email fallback timing, feed, push subscriptions, notification prefs — Notification Service.
- Harmony Points/theme — Gamification Service.
- User identity/profile/timezone — Identity Service.
- Care Link lifecycle/invites — Care Service.
- Guided-builder UI, calendar, Today screen, Dexie offline cache — combined frontend PRD + `frontend-map.md`.
- Snooze duration/re-ping policy — decided Map 1 t06 (5 min, one re-ping); enforcement is Notification's.
- Historical dose backfill — rejected for v1 (NG-8).
- Per-schedule reminder customization — fixed windows for all medicines (Map 1 t05).
- HLD/LLD/implementation → downstream artifacts per Architecture Standard.

### 7.3 Dependencies on locked decisions

- `docs/features/feature-list.md` §§5, 6, 9, 10 — guided builder → RRULE, optional start/end with visible defaults, EXDATE exceptions, fixed dose windows, missed-lock, editable-until-midnight outcomes, reminder inputs.
- `docs/contracts/service-catalog.md` — Schedule & Dose REST surface (6 public + 4 internal rows), `DoseOutcomeChanged` publish, `AccountDeleted`/`MedicineArchived` consume, event-catalog payload.
- `docs/contracts/frontend-map.md` — Today screen dose-window call, Dexie offline slice (doses cached, outcome/snooze FIFO replay, server last-write-wins), ~15 min refetch + post-mutation refresh.
- `docs/architecture/platform-quality-baseline.md` — latency/availability/retention/resilience defaults; idempotency rule (last-write-wins on outcomes).
- `docs/architecture/platform-observability.md` — logging/metrics/health/Sentry defaults.
- `docs/architecture/scheduled-jobs.md` — this service's two jobs and cadences (no deltas).
- `GLOSSARY.md` — Patient, Caregiver, Care Link, Medicine, Schedule, Dose, Doses Remaining, Refill alert, Reminder, Harmony Points, Theme state.
- Map 2 ticket 04 + Map 1 tickets 05/06/10 (via `.scratch/`) — boundary, classification ownership, pull-model reads, snooze/plan-skip distinction.
- Map 3 tickets 03/06/07/09 (via `.scratch/medo-backend/`) — self-hosted Postgres + Drizzle, per-service JWTs, Postgres outbox eventing, rate limits + check-link cache.

### 7.4 Open questions

- OQ-SD-01: ~~`MedicineArchived` suppression scope~~ — RESOLVED 2026-11-22: user approved Option A — generation stops AND that medicine's unmarked future Dose rows are excluded from `/v1/doses/due` (FR-SD-009/018 updated); rows retained as history, still queryable via patient doses read.
- OQ-SD-02: Schedule created with a past start date — occurrences before schedule-local today are never materialized (FR-SD-007b); confirm silently clamping vs rejecting past starts at write time. Owner: HLD; blocks-HLD: no.
- OQ-SD-03: `GET /v1/doses/due?window=` exact window-class enumeration and per-window DTO fields — contract detail for HLD/LLD within FR-SD-018 bounds. Owner: HLD; blocks-HLD: no.
- OQ-SD-04: DST transition behavior for schedule-local times (spring-forward gap / fall-back overlap) — tz-library resolution rule needed at LLD. Owner: HLD; blocks-HLD: no.

### 7.5 Service boundary statement

The Schedule & Dose Service solely owns the **Schedule** aggregate (recurrence definition, dose times, schedule-owned timezone, start/end, per-occurrence exceptions) and the materialized **Dose** rows with their window/outcome lifecycle (`skippedByUser` flag, `snoozedUntil`, outcome + actor attribution), plus the two embedded jobs (`dose-generation`, `missed-lock-tick`) and the `DoseOutcomeChanged` event stream. It does NOT own medicine identity/stock (Medicine Service), reminder delivery (Notification Service), points/theme (Gamification Service), users (Identity Service), or Care Links (Care Service). This matches the Schedule & Dose heading in `service-catalog.md`.

## 8. Edge cases and failure modes

| Edge case | Requirement/NFR mapping | Notes |
|---|---|---|
| Mark at exactly T+1hr boundary | FR-SD-010, 011 | Deterministic: ≤T+1hr = on-time; >T+1hr = late — single comparison rule, tz-aware |
| Mark racing missed-lock at local midnight | FR-SD-013c | Lock wins after local midnight; mark accepted only before lock commit; exactly one outcome event either way |
| Snooze across midnight | FR-SD-014 | `snoozedUntil` is transient; dose still locks missed — snooze never extends lock |
| Outcome edit after consumers already applied delta | FR-SD-012, 020 | Follow-up `DoseOutcomeChanged` carries new state; consumers recompute — at-least-once ordering preserved per patient |
| Schedule edit while doses already materialized/marked | FR-SD-004 | Regeneration touches only future unmarked rows; marked/history rows immutable |
| Schedule delete with marked history | FR-SD-005 | Future unmarked rows removed; history retained and still queryable |
| `skippedByUser` vs dose-level `skipped` | FR-SD-006 | Plan flag = no event/no outcome/no points/no Doses Remaining; dose outcome = real `skipped` (−10 pts) — never conflated |
| Time-override to an impossible/invalid time | FR-SD-001c, 006b | Rejected at write; overrides re-derive windows |
| Schedule tz ≠ patient profile tz | FR-SD-010 | Schedule-owned tz is authoritative — no silent global shifts (Map 2 t04) |
| DST spring-forward/fall-back on schedule-local times | OQ-SD-04 | LLD resolves via tz library; requirement = deterministic local-time semantics |
| Patient + caregiver mark same dose concurrently | FR-SD-015 | Last-write-wins; final event reflects last actor |
| `MedicineArchived` while future doses materialized | FR-SD-009 | Generation stops AND unmarked future doses suppressed from `/doses/due` (user-approved Option A, 2026-11-22); rows remain queryable as history |
| `AccountDeleted` while generation/tick in flight | FR-SD-021, §8.1 | Purge wins; late writes for deleted patient rejected/no-op |
| `dose-generation` partial failure mid-batch | NFR-SD-02, §8.1 | Stateless tick — failed rows retried next run; idempotent upsert prevents partial-state corruption |
| `/doses/due` called with no doses in window | FR-SD-018 | Empty result, not error — Notification polls blindly every minute |
| Care check-link down during patient-scoped call | FR-SD-022, §8.1 | Deny; ~15 s positive consumer cache absorbs brief blips |
| Caregiver link ends between list and mark calls | FR-SD-022 | Per-request check-link → instant revoke honored on next call |
| `DoseOutcomeChanged` publish failure | §8.1 | Outbox same-tx + retry → `dead_letters` after 5 attempts; no outcome without event |
| Redelivery of `MedicineArchived`/`AccountDeleted` | FR-SD-009c, 021b | Idempotent consumers — no-op on repeat |
| Schedule referencing archived medicine at create time | FR-SD-001, FR-SD-009 | Medicine record still exists (archive ≠ delete); schedule allowed but its unmarked doses are due-poll-suppressed per FR-SD-009 |

## 9. Data requirements

### 9.1 Owned data

| Entity | Lifecycle | Ownership | Notes |
|---|---|---|---|
| Schedule (patientId, medicineId, recurrence RRULE-or-date-list, doseTimes[], timezone, resolved start/end, exceptions, createdAt) | create → edit (fields + exceptions) → delete (history rows retained) | owned solely per patient; never shared | Schedule-owned tz captured at build time (Map 2 t04); references private Medicine record, never catalog entry directly |
| Dose row (scheduleId, patientId, medicineId, scheduled local date+time, outcome ∈ unmarked/taken-on-time/taken-late/skipped/missed, `skippedByUser` flag, `snoozedUntil`, actorId/actor attribution, timestamps) | materialize → mark/edit → missed-lock → retained as history (even after schedule delete) → purge on `AccountDeleted` | owned solely per patient | Materialized occurrence identity enables idempotent regeneration (FR-SD-007) |
| Outbox rows (`DoseOutcomeChanged`) | insert same-tx → publish → delete | owned solely (per-service outbox) | `@medo/eventing` pattern (Map 3 t07) |

### 9.2 Consumed/read data

- Care `GET /v1/care/check-link?patientId=&caregiverId=` — provider: Care Service, contract: internal REST. Used for caregiver authz on every patient-scoped call (FR-SD-022); consumer-side positive cache ~15 s per Map 3 t09 with `CareLinkEnded` invalidation. No other service data is read — this service never resolves medicine or user profiles.

### 9.3 Shared/community data

None — all owned data is patient-private. (Medicine Catalog is shared but owned by Medicine Service; this service references private Medicine record ids only.)

### 9.4 Retention & deletion

- Schedules + Dose rows: account lifetime; purged on `AccountDeleted` consumption (FR-SD-021). No timed purge job exists beyond the two listed in `scheduled-jobs.md`.
- Dose rows of deleted schedules: retained as patient history (FR-SD-005) — they age out only with the account.
- Dose rows of archived medicines: retained as history by design (FR-SD-009); generation stops.
- Missed-locked and final outcomes: immutable history — the audit trail for points/Doses Remaining correctness.
- No backups in v1 — accepted risk (`platform-quality-baseline.md`).

### 9.5 Sensitive data

- Dose scheduled times, outcomes, snooze state, and `medicineId`/`patientId` linkage = health-adjacent PII revealing medication adherence.
- `actorId` attribution on outcomes identifies which caregiver acted — kept per Map 1 t03.
- No credentials, tokens, or secrets stored by this service.

## 10. External contracts touched

| Contract ID (verbatim) | Direction | Sync/Async | Public/Internal | Authz | Idempotent? | Catalog ref |
|---|---|---|---|---|---|---|
| `GET /v1/patients/{id}/schedules` | exposes | REST | public | patient-self or linked caregiver | n-a | catalog §Schedule & Dose public REST |
| `POST /v1/patients/{id}/schedules` | exposes | REST | public | patient-self or linked caregiver | client retry safe — distinct schedules (baseline rule) | catalog §Schedule & Dose public REST |
| `GET /v1/schedules/{id}` | exposes | REST | public | patient-self or linked caregiver | n-a | catalog §Schedule & Dose public REST |
| `PATCH /v1/schedules/{id}` | exposes | REST | public | patient-self or linked caregiver | yes (regeneration converges to stored state) | catalog §Schedule & Dose public REST |
| `DELETE /v1/schedules/{id}` | exposes | REST | public | patient-self or linked caregiver | yes (repeat → not-found) | catalog §Schedule & Dose public REST |
| `GET /v1/patients/{id}/doses?from=&to=&outcome=` | exposes | REST | public + internal | patient-self / linked caregiver / Medo service token | n-a | catalog §Schedule & Dose public + internal REST |
| `GET /v1/doses/{id}` | exposes | REST | public + internal | patient-self / linked caregiver / Medo service token | n-a | catalog §Schedule & Dose public + internal REST |
| `POST /v1/doses/{id}/outcome` | exposes | REST | public | patient-self or linked caregiver | yes — last-write-wins on outcomes (baseline idempotency) | catalog §Schedule & Dose public REST |
| `POST /v1/doses/{id}/snooze` | exposes | REST | public | patient-self or linked caregiver | yes (repeat snooze extends `snoozedUntil`) | catalog §Schedule & Dose public REST |
| `GET /v1/doses/due?window=` | exposes | REST | internal | Medo service token | n-a (read-only poll) | catalog §Schedule & Dose internal REST |
| `GET /v1/patients/{id}/has-dose-records` | exposes | REST | internal | Medo service token (`aud=medo-schedule-dose`) | n-a | catalog §Schedule & Dose internal REST |
| `GET /v1/care/check-link?patientId=&caregiverId=` | consumes | REST | internal | Medo service token (`aud=medo-care`) | n-a | catalog §Care internal REST |
| `DoseOutcomeChanged` | publishes | event | internal | n-a | envelope `{eventId, occurredAt}`; at-least-once | catalog §Event catalog |
| `AccountDeleted` | consumes | event | internal | n-a | idempotent consumer (FR-SD-021b) | catalog §Event catalog |
| `MedicineArchived` | consumes | event | internal | n-a | idempotent consumer (FR-SD-009c) | catalog §Event catalog (added 2026-11-22) |

### 10.1 Exposed contracts — detail

- Schedule routes: list by patient, create (guided-builder payload → RRULE/date-list + times + tz + start/end), detail, PATCH (fields + exceptions), DELETE — all sync REST under `/v1`, patient-scoped authz (FR-SD-022).
- Dose routes: patient window read (`from`/`to`/`outcome` filters), dose detail, outcome mark, snooze — outcome/snooze are the only writes; both dose reads are dual-authz (public patient-scoped + internal Medo service).
- Internal routes: `/v1/doses/due?window=` serves Notification's per-minute reminder poll (excludes snoozed + `skippedByUser` + archived-medicine unmarked future rows, includes missed under midnight window); `/v1/patients/{id}/has-dose-records` serves Medicine's synchronous delete guard — current answer, no cache.
- DTO rule: all responses are boundary DTOs; dose rows never leak internal fields.

### 10.2 Consumed contracts — detail

- `GET /v1/care/check-link` (Care): consumed per patient-scoped request for caregiver sessions (FR-SD-022). Positive answers cached ~15 s consumer-side per Map 3 t09 (`CareLinkEnded` invalidates); negative answers never cached. Timeout 3 s + 1 retry; on failure → deny (authz fail-closed per baseline matrix).
- `AccountDeleted` (Identity event): purges all Schedules + Dose rows (FR-SD-021); at-least-once → idempotent consumer mandatory.
- `MedicineArchived` (Medicine event): stops dose generation for the medicine's schedules (FR-SD-009); at-least-once → idempotent consumer mandatory.

### 10.3 Events published & subscribed

- Published: `DoseOutcomeChanged` — trigger: EVERY outcome change (client mark, outcome edit, missed-lock). Payload `{doseId, medicineId, patientId, outcome, actorId?, occurredAt}` + `{eventId, occurredAt}` envelope; outcome ∈ `taken-on-time | taken-late | skipped | missed`; IDs + changed fields only per catalog conventions. Ordering: per-patient sequential via consumer offsets (`@medo/eventing`); consumers must tolerate redelivery.
- Subscribed: `AccountDeleted` (required reaction: purge schedules + dose rows, FR-SD-021) and `MedicineArchived` (required reaction: stop generation for medicine's schedules, FR-SD-009). Both consumers idempotent; 5 attempts → `dead_letters` via `@medo/eventing`.
- Downstream consumers of `DoseOutcomeChanged`: Medicine (Doses Remaining deltas) and Gamification (points/theme recompute) — both own idempotent consumption per their PRDs.

### 10.4 Authorization requirements

- Patient-scoped routes (`/v1/patients/{id}/schedules`, `/v1/patients/{id}/doses`, `/v1/schedules/{id}`, `/v1/doses/{id}` public intent, `/v1/doses/{id}/outcome`, `/v1/doses/{id}/snooze`): patient-self (`patientId` = session `sub`) OR linked caregiver via Care `check-link` per request (FR-SD-022); caregiver gets full parity incl. outcome marks with `actorId` attribution (Map 1 t03).
- Internal routes (`/v1/doses/due`, `/v1/patients/{id}/has-dose-records`, internal intent of the two dual routes): Medo service JWT only, `aud`-scoped per Map 3 t06; user tokens rejected.
- Acting-identity: every outcome record + event carries `actorId` (Patient or Caregiver userId) — attribution is a first-class requirement (FR-SD-011d).
- Frontend is never trusted: all authz server-side per request; the ~15 s check-link positive cache is the only grace window.
- `patientId` = Identity `userId` for Patient accounts (no separate Patient entity — `frontend-map.md`).

### 10.5 Versioning & compatibility

- All exposed REST contracts under `/v1`; dose/schedule IDs and `window` values are opaque strings — format may evolve without contract change.
- Evolution rule: additive-only within `/v1`; breaking changes require a new version prefix + migration note per Architecture Standard.
- Known consumers constraining evolution: Notification (`/v1/doses/due` response shape + window semantics are load-bearing for reminder + email-fallback correctness), Medicine (`has-dose-records` boolean answer + `DoseOutcomeChanged` payload for Doses Remaining), Gamification (doses read shape + `DoseOutcomeChanged` payload for ordered recompute), frontend (all public routes + Dexie replay of outcome/snooze writes).
- Event schema evolution: additive-only unless versioned; `DoseOutcomeChanged`/`AccountDeleted`/`MedicineArchived` payloads may gain fields, never lose/rename without versioning — outcome enum is closed (`taken-on-time | taken-late | skipped | missed`).

## 11. Dependencies and integrations

### 11.1 Upstream dependencies

- Own Postgres `schedule_dose_db` — Schedules, Dose rows, outbox. Failure → fail closed, 503 (baseline matrix).
- Care `GET /v1/care/check-link` — caregiver authz on patient-scoped routes; 3 s + 1 retry; fail closed (deny); ~15 s positive consumer cache per Map 3 t09.
- `broker_db` event transport via `@medo/eventing` — `DoseOutcomeChanged` publication + `AccountDeleted`/`MedicineArchived` consumption; built-in retry → `dead_letters` after 5 attempts.
- No Identity directory dependency — this service stores only `patientId`/`userId`/`actorId`/`medicineId` references, never resolves profiles or medicines.
- No direct external providers: this service never calls Resend/web-push/R2 — Notification owns all delivery; medicine display data is composed by callers, not fetched here.

### 11.2 Downstream dependents

- Notification Service — `GET /v1/doses/due?window=` per-minute poll drives Web Push reminders + email-fallback state checks (T+1hr unmarked / midnight missed, max 2/dose).
- Medicine Service — `GET /v1/patients/{id}/has-dose-records` answers the delete guard; consumes `DoseOutcomeChanged` for Doses Remaining.
- Gamification Service — `GET /v1/patients/{id}/doses` + `GET /v1/doses/{id}` pull-bootstrap; consumes `DoseOutcomeChanged` for ordered floor-0 recompute.
- Combined frontend — all public Schedule & Dose routes via gateway (schedules CRUD, dose windows, outcome/snooze marks) + Dexie offline replay.
- API gateway (Caddy/nginx) — pass-through proxy; public-route table must list Schedule & Dose routes (Map 3 t05).

### 11.3 Ordering constraints

- `POST /v1/patients/{id}/schedules` requires an existing private Medicine record — client must register/adopt the Medicine first (Medicine PRD); referential check only, no server-side ordering beyond that.
- `MedicineArchived` consumption must precede any further generation for that medicine's schedules; already-materialized rows are unaffected (FR-SD-009) — ordering vs in-flight `dose-generation` tolerated by idempotent upsert.
- `AccountDeleted` purge must complete before the account is gone; late outcome writes for the deleted patient are rejected (no session) or no-op.
- Consumers must treat `DoseOutcomeChanged` as at-least-once and per-patient ordered (consumer offsets).
- Deploy order unconstrained: this service tolerates Care/broker outages via fail-closed authz and outbox retry; missed-lock correctness depends only on own DB + clock.

## 12. Success metrics

| Goal | Metric | Instrumentation | Guardrails |
|---|---|---|---|
| G-1 | Schedule create/edit success rate; validation rejection breakdown | counters on schedule routes | Zero schedules without resolved start/end (invariant) |
| G-2 | Materialization completeness: active schedules × expected occurrences vs rows present; generation job run success | `dose-generation` job counter + reconciliation query | Zero missing occurrences within horizon (invariant); zero duplicate rows |
| G-3 | Outcome classification correctness: marks accepted/rejected per window; edit-until-midnight enforcement | counters on outcome route + contract tests | Zero post-lock mutations (invariant); zero client-missed accepts |
| G-4 | `DoseOutcomeChanged` emission completeness: outcome writes vs events published | outbox lag + publish counter | Zero outcomes without event (same-tx invariant) |
| G-5 | Read API p95 per class; `/doses/due` poll latency | `/metrics` RED + custom poll counter | p95 < 300/500/200 ms per NFR-SD-01 |
| G-6 | Purge completeness on `AccountDeleted`; generation-stop correctness on `MedicineArchived` | consumer counters + post-consume verification | Zero surviving rows post-deletion; zero new rows post-archive |
| G-7 | Missed-lock timeliness: lock latency after schedule-local midnight | `missed-lock-tick` counter + timestamp diff | ≤60 s per `scheduled-jobs.md` |

## 13. Assumptions and constraints

- Locked decisions cited, not re-decided: materialized dose rows + rolling 90-day horizon + nightly extension (Map 2 t04); schedule-owned timezone (Map 2 t04); classification ownership + event-on-every-change (Map 2 t04); pull-model reads + `has-dose-records` fail-closed consumer (Map 2 t04/05); snooze transient + plan-skip vs dose-skip distinction (Map 2 t04); guided builder → RRULE + optional start/end + EXDATE (Map 1 t05); fixed dose windows + missed-lock + edit-until-midnight (Map 1 t05/06); reminder inputs (Map 1 t06); outcome→points mapping is Gamification's (Map 1 t10); authz parity + actor attribution (Map 1 t03); `MedicineArchived` consume semantics (Map 4 t07 catalog amendment).
- Technical constraints already decided: Node.js + TypeScript + Fastify + Drizzle (Map 3 t01); self-hosted PostgreSQL one container/six logical DBs (Map 3 t03); Docker Compose on EC2 (Map 3 t02); Postgres outbox eventing via `@medo/eventing` (Map 3 t07); per-service asymmetric JWTs (Map 3 t06); rate limits + check-link cache (Map 3 t09); embedded node-cron jobs (Map 3 t01 + `scheduled-jobs.md`).
- This PRD assumes the Architecture Standard's four-layer backend structure and one-combined-frontend topology; it does not re-decide them.
- Domain selection (`app.<domain>`/`api.<domain>`) remains map fog — non-blocking; no hostname-dependent behavior in this service.
- RRULE subset (none-as-date-list/weekly/monthly/yearly) and EXDATE exception encoding are requirement-level; exact RRULE string generation/expansion library is LLD detail.
- `/v1/doses/due` window-class enumeration is bounded by FR-SD-018; exact `window` parameter values are contract detail (OQ-SD-03).

## 14. Glossary and terminology

Terms used → `GLOSSARY.md` anchors: **Patient**, **Caregiver**, **Care Link**, **Medicine**, **Schedule**, **Dose**, **Doses Remaining**, **Refill alert**, **Reminder**, **Harmony Points**, **Theme state**.

Avoid-list compliance: no "reminder/alarm/alert/notification" for Schedule or Dose in normative text (Reminder is the glossary term for the notification itself — this service produces dose *state*, not reminders); no "plan" for Schedule (Schedule is the glossary term — "plan-skip" appears only as the established `skippedByUser` concept name); no "score/points/health" for Harmony Points; no "drug/medication/prescription" for Medicine.

New technical terms (flagged `proposed-glossary-entry` for HLD/LLD clarity):

- **Materialized Dose row** — a persisted occurrence generated from a Schedule; the unit reminders, outcomes, and history operate on.
- **Dose window** — the fixed lifecycle bands: takeable T−30min / on-time until T+1hr / late until schedule-local midnight / missed after.
- **Missed-lock** — the per-minute job transition marking prior-local-day unmarked doses `missed` and locking them immutable.
- **`skippedByUser` (plan-skip flag)** — a Schedule-level exception materialized on the Dose row; history only, never an outcome.
- **`snoozedUntil`** — transient timestamp field suppressing due-poll visibility; not an outcome, no event.
- **Guided-builder payload** — the schedule write contract shape: recurrence (RRULE/date-list) + dose times + timezone + start/end + exceptions.
- **Rolling horizon** — the today → today+90d (schedule-local) materialization window maintained by `dose-generation`.

## 15. Traceability matrix

| Need (feature-list §) | Goal | Story | FR/NFR | Contract(s) | Verification |
|---|---|---|---|---|---|
| §5 scheduling (guided builder → RRULE, start/end, exceptions) | G-1 | US-SD-01 | FR-SD-001…006 | schedule routes | contract + integration tests |
| §5 fixed dose windows | G-3 | US-SD-03, 04 | FR-SD-010…013 | outcome/snooze routes, `DoseOutcomeChanged` | unit (tz matrix) + integration tests |
| §6 reminders inputs (dose times, missed-lock, Today data) | G-2, G-5 | US-SD-02, 06 | FR-SD-007…009, 016…018 | `/doses/due`, doses reads | integration + load tests |
| §6 missed = locked + penalty input | G-3, G-4 | US-SD-04, 05 | FR-SD-013, 020 | `DoseOutcomeChanged` | integration tests (fake clock) |
| §3 authorization parity + attribution | G-1, G-3 | US-SD-01, 03 | FR-SD-022, NFR-SD-04 | `check-link`, all patient routes | contract tests (Care stubbed) |
| §10 gamification inputs (outcome stream, bootstrap read) | G-4, G-5 | US-SD-05, 06 | FR-SD-016, 017, 020 | doses reads, `DoseOutcomeChanged` | contract + integration tests |
| §4/§8 medicine linkage (schedule→private Medicine; delete guard; archive) | G-6 | US-SD-07, 08 | FR-SD-001b, 009, 019 | `has-dose-records`, `MedicineArchived` | integration tests |
| Account-deletion safety | G-6 | US-SD-08 | FR-SD-021, NFR-SD-05 | `AccountDeleted` | integration tests |
| Platform NFRs | — | — | NFR-SD-01…06 | `/metrics`, `/health`, `/ready` | metric checks + smoke tests |

## Appendix A. Alternatives considered

- **RRULE vs simple recurrence (interval/weekday lists)** — RRULE chosen Map 1 t05 (RFC 5545 industry standard; guided builder emits it); rejected bespoke JSON recurrence as non-standard.
- **Materialized rows vs compute-on-read** — materialized chosen Map 2 t04: hourly reminders, midnight missed-lock, and ordered points recompute all need persisted occurrences; rejected pure expansion-on-query.
- **Schedule-owned tz vs Identity profile tz** — schedule-owned chosen Map 2 t04: no silent global shifts when a user travels or edits profile; rejected profile-tz lookup (cross-service dependency + surprise mutations).
- **Push reminder events vs pull `/doses/due`** — pull chosen Map 2 t05: Notification owns all reminder policy; zero reminder-state events; rejected `DoseReminderDue` push events (duplicates policy in producer).
- **Event on finalized outcomes only vs every change** — every-change chosen Map 2 t04: Doses Remaining and points must follow editable-until-midnight state; rejected locked-only batching.
- **Shared-secret internal auth vs per-service JWTs** — per-service asymmetric JWTs chosen Map 3 t06 (user override of shared-secret recommendation).
- **Broker product (Redis/Kafka) vs Postgres outbox** — outbox+polling chosen Map 3 t07: no extra infra at hackathon scale; ordering + dead-letters preserved.
- **Retroactive missed-marking for past occurrences** — rejected: v1 materializes forward only (NG-8); backfill is a later-version concern.

## Appendix B. HLD-readiness checklist result

- Result: **pass**
- Date: 22-11-26 05-08-28 UTC (approved same timestamp)
- Checker: Devin (self-check vs `prd-standard.md` §7 + `prd.schema.json`)
- Conditions: none — OQ-SD-01 resolved via user decision (Option A, 2026-11-22); OQ-SD-02/03/04 non-blocking (HLD/LLD detail). Front-matter `hld_readiness` mirrors this verdict pending approval.
