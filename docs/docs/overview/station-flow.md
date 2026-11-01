---
id: station-flow
title: Station flow
sidebar_label: Station flow
---

# Station flow (fulfillment-execution)

Routes: `/` the station screen, `/task` the task screen. Every request goes to
`/api/fulfillment-execution/...` through Kong
([API contract](/docs/ecosystem/api-contract)); every command carries an
`Idempotency-Key` ([Offline and idempotency](./offline-and-idempotency.md)).

## Station screen

Code: `src/features/station/StationScreen.tsx`, state in
`StationProvider.tsx` and `stationState.ts`.

1. **Register.** Station ID, capabilities (comma separated, default `pick`),
   optional location code. `POST /stations` upserts, so registering again
   (the "Register this station again" disclosure) is how a station is
   re-certified.
2. **Check in.** Scan the badge (`occupantId`). One occupant at a time: a
   second check-in is `409 station-occupied`.
3. **Pull work.** One button per claimable type: Pick, Relocate, Replenish
   (`CLAIMABLE_TASK_TYPES`). `claim-next` returns `200` with the task and a
   lease, or `409 no-claimable-task` when the pool has nothing this station can
   do (shown as a calm "nothing waiting", not an error), or
   `404 station-not-found` when the station is not registered (for example the
   service restarted). A successful claim navigates to `/task`.
4. **Check out.** Disabled while a task is held.

While the station is registered and a task is held, the station screen shows a
"Go to the task" link instead of the pull buttons.

Pack, SLAM, Rebin, Dispatch and Arrival tasks are not offered (their completion
belongs to later screens). If one is held, for example from persisted state, the
task screen says "Cannot finish here" and keeps renewing its lease.
`BREAK_CASE` is not offered at claim time either (the OpenAPI `AnyTaskType` does
not list it) but has its own task screen when held.

## Task screen

Code: `src/features/task/TaskScreen.tsx`, `confirmPlan.ts`, `scanCopy.ts`.

- Header: type, id, status pill, order, CPT, move/replenishment details,
  fragile and gift-wrap flags.
- **Lease countdown** (`LeaseCountdown`), visible, `m:ss`, with a plain-words
  note ("Renews automatically.", "Could not renew. Reconnect soon or the task
  goes back to the pool.", "Your claim has run out...").
- **Scan to confirm**, then **Complete task**. The scan field is the shared
  `ScanInput`.

| Type | Scans | Quantity | `complete` request body |
|---|---|---|---|
| PICK | the order label (`orderRef`, case-insensitive; the task id when there is no `orderRef`); item and case barcodes are counted as they are picked (below) | no | `{stationId}` |
| RELOCATE | source bin, destination bin; a side the plan fixes must match it, an open side (source of an Assign, destination of a Vacate) accepts any scan; the two bins must differ | counted, >= 1 | `{stationId, quantity, fromBin, toBin}` |
| REPLENISH | reserve bin, pick face: must match the plan | counted, defaults to the planned quantity | `{stationId, quantity, fromBin, toBin}` |
| BREAK_CASE | none: the **Break case** button | no | `POST /tasks/{id}/break-case` `{stationId}` |

A fixed side is sent with the planned spelling, so a lower-case manual entry
cannot trip the service's equality check.

### Counting a pick

On a PICK task any scan that is not the order label is parsed as a barcode
(`src/lib/gs1`): the 14-digit GTIN of an item or case is sent as
`POST /tasks/{id}/scans` `{stationId, gtin, count: 1}`. Each physical scan is
its own action with its own key (`dedupeId = pick-scan:<taskId>:<scanId>`), so
two scans of the same case count twice, while a scan saved offline or whose
answer was lost is replayed with **its** key. A case GTIN counts cases; the
server multiplies, the client never does. The screen shows the running total
the service returns: "Picked N of M eaches (sku)". A scan the service refuses
(`unknown-gtin`, `invalid-scanned-gtin`, `scan-sku-mismatch`,
`scan-level-mismatch`, `pick-over-quantity`, `no-pick-plan`) is explained in
plain words and nothing is counted. The order-label scan and Complete still
work after item scans.

### Breaking a case

A `BREAK_CASE` task shows no scan field. **Break case** sends
`POST /tasks/{id}/break-case` `{stationId}` and, on `204`, ends the task in one
step. The action is keyed once per task (`dedupeId = break-case:<taskId>`), so
a re-tap or a reload reuses its key; `503 case-break-unavailable` is retried,
not shown as a failure.

## Lease semantics

- The service grants 5 minutes by default. The client learns the lease length at
  claim time (`leaseExpiry` minus the response `Date`), accepts 10 s to 60 min,
  falls back to 5 minutes, and keeps the deadline in the **local** clock, so
  device clock skew cannot corrupt the countdown.
- At half-life (or less) the client calls `POST /tasks/{id}/renew-lease`
  (`204`, no body). It retries a failed renewal no more often than every 10 s. A
  successful renewal resets the local deadline to a full lease.
- `409 task-not-claimed` / `task-not-owner` or `404 task-not-found` on renew,
  scan, complete or break means the claim is gone: the task is dropped and the
  operator is told to pull again.
- `409 task-already-completed` on complete or break is treated as done.
- Complete while offline is saved and replayed (see
  [offline and idempotency](./offline-and-idempotency.md)); the task screen
  shows "Completion saved on this device".

## Receiving dock (inbound-receiving)

Routes: `/receiving` (open a receipt by id, or pick one of the open receipts)
and `/receiving/:receiptId` (the receiving screen). Details:
[Receiving flow](./receiving-flow.md).

**Design decision: receiving is not a station task.** The app shell was written
around fulfillment-execution (register a station, check in, claim a task, hold
a lease). Receiving needs none of it: inbound-receiving has no stations, no
claim and no auth layer (fleet decision 2026-09-11), and a receipt is worked by
whoever stands at the dock. So the smallest additive change was taken:

- two routes beside `/` and `/task`, plus a "Receiving" nav item (`Layout`);
  nothing in `StationProvider`, the lease logic or the pick and break-case
  screens changed by it;
- no station id, no occupant id, no capability: the receipt id in the URL is the
  whole context;
- the receiving screen keeps its own notices (the shared `NoticeBar` belongs to
  the station state) and reads receipts with plain `GET`s (reads are not
  commands).

If a later wave needs "who received this" (labor tracking), an operator id has
to come from somewhere (badge scan at the receiving screen); that is a new
decision, not made here.
