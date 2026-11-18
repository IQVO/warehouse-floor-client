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
| Check in | `POST /visits` `{siteId, carrier, carrierScac?, tractorPlate, driverRef?, purpose, appointmentId?, trailers[]{unitNumber, kind, loadState, sealNumber?, sealClass?}}` | types carrier, plate, purpose and the optional appointment id; **scans** each trailer's unit number, then picks kind, load state, types the seal and may state the seal's strength ([Seal strength](#seal-strength-sealclass)). Answer `CheckIn {visit, trailers[], moves[]}`: the screen lists, per trailer, where the driver takes it (the move's `to` and reason). A `REJECTED` visit (seal policy `REJECT`) is shown as "turned away" with its `rejectionReason` in words (`rejectionText` in `yardFormat.ts`): the six values of the `Visit` schema, `CARRIER_SUSPENDED` included, have wording, and a value this build does not know is shown as "reason `<CODE>`", never as `undefined` |
| Reject | `POST /visit-rejections` `{siteId, carrier, carrierScac?, tractorPlate, appointmentId?, reason}` | picks one of the five `RejectionReason`s the request accepts. `CARRIER_SUSPENDED` is not offered: the service sets it itself (suspended carrier under policy `REJECT`, yard-management ADR 0016) and `RejectVisitRequest.reason` does not list it |
| Check out | `GET /visits?siteId&state=CHECKED_IN`, `GET /trailers?siteId`, `POST /visits/{id}/check-outs` `{trailersOut:[{trailerId}]}` | picks the truck, ticks the trailers that leave with it. A live unload/load ticks its ready trailer by default; a drop leaves its trailer (empty `trailersOut`); for a pickup the clerk scans the unit number of a parked trailer |

### Check-in form fields

| Field on the screen | Sent as | Rule on the device |
|---|---|---|
| Carrier | `carrier` | required, 100 characters at most |
| Carrier code (optional) | `carrierScac` | 2 to 4 letters, sent in capitals; left out when empty |
| Tractor plate | `tractorPlate` | required, sent in capitals, 32 at most |
| Appointment id (optional) | `appointmentId` | 64 at most; left out when empty |
| Purpose | `purpose` | one of the five `Purpose` values |
| Scan the trailer unit number | `trailers[].unitNumber` | through `readYardCode`; no duplicates |
| Kind of trailer N | `trailers[].kind` | required |
| Load state N | `trailers[].loadState` | required |
| Seal number N (optional) | `trailers[].sealNumber` | 64 at most; left out when empty |
| Seal strength N (optional) | `trailers[].sealClass` | shown only while a seal number is typed; `I`, `S` or `H`, or left out |

Every optional field that is empty is **left out** of the body; the client never sends `""` or `null` for it. `driverRef` is in the request type and is left out: the form has no field for it.

### Seal strength (`sealClass`)

`TrailerIn.sealClass` of the OpenAPI: `type: string`, `enum: [I, S, H]`, "Optional ISO 17712 class of the seal (I indicative, S security, H high security); needs a sealNumber. Refused with 409 `seal-class-too-low` when below the `minimumSealClass` of the site yard policy" (yard-management ADR 0012: I below S below H; with a minimum set, a seal **with no class** is refused too, and a trailer with no seal is not judged).

- The choice appears under the seal number once a seal number is typed. It is a `<select>` like kind and load state (56 px high), and it starts at **Not stated**, which sends no `sealClass`.
- The clerk reads words; the letter marked on the seal or written on the paperwork comes second, in brackets: **Light seal: only shows tampering (I)**, **Security seal (S)**, **High-security seal (H)** (`SEAL_CLASS_TEXT` in `yardFormat.ts`). A hint says where the letter is found and that it may stay not stated.
- Clearing the seal number clears the choice, and `buildCheckIn` leaves the class out of any trailer with no seal number: the service answers `422 validation` to a class with no seal.
- A value that is not one of the three (a tampered or stale form) is refused on the device: "Trailer N: choose the seal strength again."
- No stored shape changes. A check-in is queued with its body exactly as built, `sealClass` included; a check-in queued by an earlier build has no `sealClass` and replays as it is, because the field is optional (`wfc.outbox.v1` keeps its version, and `outboxMigration.ts` has nothing to rewrite).

Hazard class and UN number (`hazmatClass`, `unNumber`) have **no** input on this form; that is out of scope here.

### Turned away by the service (`carrier-suspended`)

`409 carrier-suspended` is the one refusal that is not "nothing happened": under the site rule `REJECT` the service records the `REJECTED` visit (reason `CARRIER_SUSPENDED`) and **then** answers the 409 (yard-management ADR 0016). A second check-in of the same truck is a new request with a new `Idempotency-Key`, and it would put a second turn-away on record. So this answer ends the truck on the screen, the way a successful check-in does:

- **The truck in the form was the one turned away** (the clerk tapped and got the 409, or a saved check-in for the same site and plate that is still in the form was replayed): the form is cleared and hidden, and its place is taken by the card "`<PLATE>` is turned away" (`TurnedAway.tsx`, `turnAway.ts`): the operator message (below, with no Dismiss) and one button, **Start the next truck**. Nothing typed for that truck is left on the screen, so no tap and no scanner Enter can send it again. The card stays while the clerk looks at Reject or Check out and comes back; **Start the next truck** is the only way on, and it opens an empty form.
- **An earlier truck was turned away** (its check-in was saved offline and is answered while the clerk is already typing the next truck, or after a reload emptied the form): the same card announces it by plate, above the form, with a **Dismiss**. The form is not touched: the truck in it was never sent, and it can be sent once, as usual. The gate screen holds what is typed (`draft` in `GateScreen.tsx`) and compares the site and plate of the answered command with it, which is how the two cases are told apart.
- When several saved check-ins are answered one after another, the card names every plate ("Turned away: `<PLATE>`, `<PLATE>`"), so no driver is missed.
- On a **replay** the outbox entry is finished with that answer and is never sent again (every 4xx is definitive, see [Offline and idempotency](/docs/overview/offline-and-idempotency#definitive-vs-retryable)).
- **When the gate screen is not in view** (the clerk is on another screen when the replay is answered), nothing here can show it, so the global notices do, once: "Saved check-in (truck `<PLATE>`): This carrier is suspended, so the truck is turned away. The turn-away is already recorded." with the same what-to-do. See [Who shows a replayed answer](/docs/overview/offline-and-idempotency#who-shows-a-replayed-answer). It is never said in another context's words.

Turning the same truck away by hand (Reject) is still possible and still wrong; the message says so.

### Trailer rules

From the OpenAPI and enforced on the device before anything is sent: a visit that names an appointment brings **exactly one** trailer; otherwise one or more; a **bobtail** or a **pickup** brings none (the OpenAPI says so, and a pickup takes a parked trailer out at check-out). Plate and carrier code are sent in capitals. "Ready to leave" next to a trailer is only a hint (no open move, and parked or docked with door work done); the service decides (`trailer-not-released`).

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

yard-management enforces `Idempotency-Key` on every creating `POST` (per its OpenAPI; a replay answers `Idempotency-Replayed: true`). That is read from the spec; it was not exercised against a live service from this repo (the stub implements the same rule). The answer of a command that was saved offline or whose answer was lost is shown when the replay settles, also after a reload: by the yard screen that owns the command when it is in view (gate: check-in, reject, check-out; hostler: claim, move completion; dock: door work, move completion), otherwise by the global notices in the yard's words ([Who shows a replayed answer](/docs/overview/offline-and-idempotency#who-shows-a-replayed-answer)). Reads (`GET`) are plain fetches: no key, no outbox; offline, a list cannot be (re)loaded.

## Errors

Problem `type` = `https://errors.yard-management.warehouse-systems.dev/<slug>`; the client keys on `<slug>` (`src/api/yardMessages.ts`) and never shows `detail`. Covered: `appointment-required`, `unknown-appointment`, `visit-already-open`, `trailer-already-on-site`, `door-closed`, `door-flow-mismatch`, `no-free-spot`, `invalid-carrier`, `validation`, `illegal-transition`, `trailer-not-released`, `seal-required`, `trailer-on-hold`, `trailer-has-open-move`, `hostler-busy`, `no-claimable-move`, `not-lease-holder`, `unexplained-destination`, `location-occupied`, `destination-reserved`, `unknown-location`, `trailer-not-found`, `visit-not-found`, `move-not-found`, `malformed-request-body`, `precondition-failed`, `dependency-unavailable`, and the nine of the table below. Idempotency, 5xx and gateway answers fall back to the shared table. `429/502/503/504` are retried, not shown.

The slugs of yard-management ADR 0012 to 0016. None of them is fixed by sending the same thing again, so none says "try again" on its own:

| Slug | Status | Met on | What the operator reads / what to do |
|---|---|---|---|
| `carrier-suspended` | 409 | check-in | This carrier is suspended, so the truck is turned away. The turn-away is already recorded. / The truck does not enter. Tell the driver. Nothing more to enter: do not check it in again or use Reject. Shown in the [turned-away card](#turned-away-by-the-service-carrier-suspended), not as a dismissable notice. |
| `seal-class-too-low` | 409 | check-in | This site only takes seals of a set strength, and this trailer's seal is weaker or its strength was not stated. / If the seal strength was left out, choose it and check in again. If the seal really is weaker, tell your lead: the truck waits at the gate or is turned away (Reject at the gate). |
| `invalid-seal-class` | 422 | check-in | The system did not accept the seal strength that was sent. / Choose the seal strength again, or set it to Not stated, then check in again. If it keeps happening, call your lead. |
| `invalid-unit-number` | 422 | check-in | That is not a valid container number: 4 capital letters and 7 digits, with no spaces or dashes. / Check it against the number on the container and enter it again. If the unit is not a container, change its kind. |
| `placement-rule-violated` | 409 | move completion (hostler, dock); check-in | This trailer carries dangerous goods or a load that needs cooling, and it may only stand on a spot set aside for that. / Take it to a spot set aside for that load and scan that one. If there is none, ask your lead. |
| `trailer-not-secured` | 409 | door work start | This site starts door work only on a trailer that is recorded as secured (restraint or wheel chocks). / Secure the trailer and tell your lead, so it is recorded. Then start door work again. |
| `trailer-still-secured` | 409 | check-out; claim | A trailer is still secured at its dock door (restraint or wheel chocks), so it cannot leave. / It has to be released at the dock first, and the release recorded. Tell your lead, then try again. |
| `inspection-required` | 409 | door work start, check-out, move completion at a door | This site wants a passed inspection of the trailer before this step, and none is on record. / Tell your lead. Try again once the trailer has been inspected and passed. |
| `inspection-failed` | 409 | the same three | The trailer's latest inspection failed, so this step is blocked. / Tell your lead. The trailer has to be inspected again and pass first. |

Every refusal but one leaves the form as it was typed, so the clerk corrects it and sends it again. `carrier-suspended` ends the truck instead: see [Turned away by the service](#turned-away-by-the-service-carrier-suspended).

`seal-class-too-low` is the one the clerk can fix on this screen, by stating the seal strength; a seal that really is weaker goes to the lead. `invalid-seal-class` cannot come from the three choices the form offers; it has copy because the form sends the field, and the service may one day know a class this build does not. The two securing slugs and the two inspection slugs send the operator to the lead because this client has no screen for the fix: it does not record or release a securing (`POST /trailers/{id}/securings`, `/securing-releases`), and it does not open or complete inspections.

Left on the shared fallback (the service's title, then "Try again. If it keeps happening, call your lead."), on purpose:

- `invalid-hazmat-class`, `invalid-un-number`: the OpenAPI names them on `POST /visits`, for `hazmatClass` and `unNumber`. The check-in form has no hazard class and no UN number input (out of scope when the seal strength was added), so it sends neither and no operator can meet them. A screen that starts sending one of the fields adds the copy with it, as the seal strength did for `invalid-seal-class`.
- `concurrent-modification` (409, two writes at the same moment): the service answers it on any command, but its OpenAPI does not name it, so it is not in the list the test checks. For this one "try again" is the right advice.

## Spec observations

- The OpenAPI gives every route the same shared `409` / `422` responses, so which slug a route answers is read from the operation descriptions and from yard-management ADR 0012 to 0016. `validation` has no example (it is named in the check-in description). `concurrent-modification` is in the service's error catalogue and not in the OpenAPI at all.
- `inspection-required` / `inspection-failed` on a move completed at a door comes from the service code (the arrival at a door is judged); the OpenAPI and ADR 0015 name the move request, the door work start and the check-out.
- `If-Match` is not sent: no screen edits a copy it read earlier.
- A pickup that names an appointment cannot satisfy both "a visit that names an appointment brings exactly one trailer" and "a pickup brings none"; the client sends what the form allows and shows the service's answer.
