---
id: yard-flow
title: Yard flow
sidebar_label: Yard flow
---

# Yard flow (yard-management)

Source of truth: `apis/openapi.yaml` in IQVO/yard-management (read from the service branch until it is on `origin/develop`); its server entry for Kong is `/api/yard-management`. All paths below are under that prefix at this app's own origin. Client code: `src/api/yardManagement.ts` (types, commands, reads), `src/api/yardMessages.ts` (operator text), `src/features/yard/` (screens).

Three screens, one per person at the yard. Each keeps the **site code** (and the hostler's id) on the device (`wfc.yard.v1`); every call is scoped by `siteId`.

## Gate clerk, `/yard/gate`

| Job | Request | What the clerk does |
|---|---|---|
| Check in | `POST /visits` `{siteId, carrier, carrierScac?, tractorPlate, driverRef?, purpose, appointmentId?, trailers[]{unitNumber, kind, loadState, sealNumber?}}` | types carrier, plate, purpose and the optional appointment id; **scans** each trailer's unit number, then picks kind, load state and types the seal. Answer `CheckIn {visit, trailers[], moves[]}`: the screen lists, per trailer, where the driver takes it (the move's `to` and reason). A `REJECTED` visit (seal policy `REJECT`) is shown as "turned away" |
| Reject | `POST /visit-rejections` `{siteId, carrier, carrierScac?, tractorPlate, appointmentId?, reason}` | picks one of the five `RejectionReason`s |
| Check out | `GET /visits?siteId&state=CHECKED_IN`, `GET /trailers?siteId`, `POST /visits/{id}/check-outs` `{trailersOut:[{trailerId}]}` | picks the truck, ticks the trailers that leave with it. A live unload/load ticks its ready trailer by default; a drop leaves its trailer (empty `trailersOut`); for a pickup the clerk scans the unit number of a parked trailer |

Trailer rules, from the OpenAPI and enforced on the device before anything is sent: a visit that names an appointment brings **exactly one** trailer; otherwise one or more; a **bobtail** or a **pickup** brings none (the OpenAPI says so, and a pickup takes a parked trailer out at check-out). Plate and carrier code are sent in capitals. "Ready to leave" next to a trailer is only a hint (no open move, and parked or docked with door work done); the service decides (`trailer-not-released`).

## Hostler, `/yard/hostler`

1. **Claim next move**: `POST /moves/claims {siteId, hostlerRef}`. The system picks the move (band, then due time, then age); the screen never lists a queue to choose from. One move at a time (`hostler-busy`).
2. The claimed move shows the trailer (unit number, from `GET /trailers/{id}`), **from, to, why, due** and a **lease** countdown. yard-management has no lease renewal: the countdown says the lease cannot be extended and a move not finished in time goes back to the queue.
3. **Complete**: scan the spot or door where the trailer was left; `POST /moves/{id}/completions {hostlerRef, actualLocation:{kind, code}, deviationNote?}`. At the planned place no note is needed. At another place the screen asks for what it is (spot or door) and a reason, which the service requires (`unexplained-destination`). An occupied place keeps the move in hand (`location-occupied`).

The held move is kept on the device (`wfc.yard.hostler.v1`) and, on load, checked against `GET /moves?siteId&state=CLAIMED`: a move the service says this hostler holds is adopted (a lost claim answer), one it no longer lists is dropped with a note.

## Dock operator, `/yard/dock`

- **Trailers at doors**: `GET /trailers?siteId` filtered to `DOCKED`, sorted by door. Each card offers the next door-work step: **Start door work** (`POST /trailers/{id}/door-work-starts`, no body) when `WAITING`, **Complete door work** (`POST .../door-work-completions {loadState?}`) when `IN_PROGRESS`, with a load-state choice (EMPTY suggested for an inbound unload, LOADED for outbound, otherwise left to the service). A held trailer says why and cannot start. Scanning a door or a unit number shows just that trailer.
- **Drivers bringing their own trailer**: `GET /moves?siteId&state=CLAIMED` filtered to `VISITING_DRIVER`. The operator picks one, scans the place the trailer reached and completes it **without `hostlerRef`** (same completion call, same deviation rule).

## Scanning

Spot, door and unit-number scans go through `readYardCode` (`src/features/yard/yardScan.ts`), which calls `parseScan` first. A GS1 product or carton barcode (GTIN, SSCC, element string) is refused ("not a spot or door label"); anything else `parseScan` calls INVALID is not GS1 and is used verbatim (a facility-layout `locationCode` such as `WH1-DOCK-IN-01`, a painted unit number). Limits follow the API (unit 64, location 128, printable ASCII). Consequence: a label that is only digits and is a valid GTIN or SSCC cannot be scanned as a yard label. All scan fields are the shared `ScanInput` (wedge + "Type instead").

## Commands, keys and retries

All through `CommandRunner`; the `dedupeId` names the logical action, so a second tap, a reconnect replay or a reload reuses the key while the body is unchanged (a changed body gets a new key).

| Kind | `dedupeId` |
|---|---|
| `yard-check-in` | `yard-check-in:<siteId>:<plate>` (one open visit per plate) |
| `yard-reject` | `yard-reject:<siteId>:<plate>` |
| `yard-check-out` | `yard-check-out:<visitId>` |
| `yard-claim` | `yard-claim:<siteId>:<hostlerRef>` |
| `yard-complete-move` | `yard-complete-move:<moveId>` |
| `yard-door-start` / `yard-door-complete` | `...:<trailerId>` |

yard-management enforces `Idempotency-Key` on every creating `POST` (per its OpenAPI; a replay answers `Idempotency-Replayed: true`). That is read from the spec; it was not exercised against a live service from this repo (the stub implements the same rule). The answer of a command that was saved offline or whose answer was lost is shown when the replay settles, also after a reload. Reads (`GET`) are plain fetches: no key, no outbox; offline, a list cannot be (re)loaded.

## Errors

Problem `type` = `https://errors.yard-management.warehouse-systems.dev/<slug>`; the client keys on `<slug>` (`src/api/yardMessages.ts`) and never shows `detail`. Covered: `appointment-required`, `unknown-appointment`, `visit-already-open`, `trailer-already-on-site`, `door-closed`, `door-flow-mismatch`, `no-free-spot`, `invalid-carrier`, `validation`, `illegal-transition`, `trailer-not-released`, `seal-required`, `trailer-on-hold`, `trailer-has-open-move`, `hostler-busy`, `no-claimable-move`, `not-lease-holder`, `unexplained-destination`, `location-occupied`, `destination-reserved`, `unknown-location`, `trailer-not-found`, `visit-not-found`, `move-not-found`, `malformed-request-body`, `precondition-failed`, `dependency-unavailable`. Idempotency, 5xx and gateway answers fall back to the shared table. `429/502/503/504` are retried, not shown.

## Spec observations

- Not in the OpenAPI as written: `visit-not-found` / `move-not-found` (only `trailer-not-found` is exemplified; the other two are the same pattern) and the `validation` slug (named in the check-in description).
- `If-Match` is not sent: no screen edits a copy it read earlier.
- A pickup that names an appointment cannot satisfy both "a visit that names an appointment brings exactly one trailer" and "a pickup brings none"; the client sends what the form allows and shows the service's answer.
