# Station flow (fulfillment-execution)

Routes: `/` the station screen, `/task` the task screen.

## Station screen

1. **Register.** Station ID, capabilities (comma separated, e.g. `pick`), optional location code. `POST /stations` upserts, so registering again is how a station is re-certified.
2. **Check in.** Scan the badge (`occupantId`). One occupant at a time: a second check-in is `409 station-occupied`.
3. **Pull work.** Buttons for the task types this client can finish: Pick, Relocate, Replenish. `claim-next` returns `200` with the task and a lease, or `409 no-claimable-task` when the pool has nothing this station can do (shown as a calm "nothing waiting", not an error), or `404 station-not-found` when the station is not registered (e.g. the service restarted).
4. **Check out.** Disabled while a task is held.

Pack, SLAM, Rebin, Dispatch and Arrival tasks are not offered (their completion belongs to later screens). If one is somehow held (e.g. from persisted state) the task screen says so and keeps renewing its lease.

## Task screen

- Header: type, id, status pill, order, CPT, move/replenishment details, fragile/gift-wrap flags.
- **Lease countdown**, visible, `m:ss`, with a plain-words note ("Renews automatically", "Could not renew...", "Your claim has run out").
- **Scan to confirm**, then **Complete**:

| Type | Scans | Quantity | Request body |
|---|---|---|---|
| PICK | item and case barcodes as they are picked (each is its own `POST /tasks/{id}/scans`, see below), then the order label (`orderRef`, case-insensitive) | no | `{stationId}` |
| BREAK_CASE | none: the **Break case** button | no | `POST /tasks/{id}/break-case` `{stationId}` |
| RELOCATE | source bin, destination bin; a side the plan fixes must match it, an open side (source of an Assign, destination of a Vacate) accepts any scan | counted, >= 1 | `{stationId, quantity, fromBin, toBin}` |
| REPLENISH | reserve bin, pick face: must match the plan | counted, defaults to the planned quantity | `{stationId, quantity, fromBin, toBin}` |

### PICK: scan-confirm

One focus-locked field takes both kinds of scan. The order label (when it matches `orderRef`) unlocks Complete as before. Anything else is parsed by `src/lib/gs1/`:

- an each EAN/UPC (`]E0`, bare digits), a case ITF-14 (`]I1`) or a GS1-128 with AI 01 (`]C1`, GS-separated lot/expiry allowed) becomes `POST /tasks/{id}/scans` `{stationId, gtin: <14 digits>, count: 1}`. The screen shows `Picked N of M eaches (SKU)` from the answer; the pick is complete when N = M, then scan the order label and Complete. The client does not know whether the task is planned in eaches or cases, nor the pack factor; it only counts what the service answers;
- a bad check digit, an SSCC, a pallet/mixed-carton label (AI 02) or a weight-priced GTIN is refused on the device in plain words, with no request;
- the service's refusals (`unknown-gtin`, `invalid-scanned-gtin`, `scan-sku-mismatch`, `scan-level-mismatch`, `pick-over-quantity`, `no-pick-plan`) show as what-happened / what-to-do, count nothing and leave the task in hand;
- offline, or when the answer is lost, the scan stays in the outbox with its key ("N scans are saved on this device"), and is sent once, in order, before the completion. A plain order-label-only completion (no item scans) still works, e.g. for a task released without a pick plan.

### BREAK_CASE

Shown when the held task is `BREAK_CASE` (an each pick found only a sealed case). The screen says to open the case at the pick face and press **Break case**: one `POST /tasks/{id}/break-case` completes the task after inventory-storage breaks the container. It has no plain Complete (the service refuses it). The command's key is stable per task, so a second tap, a lost answer or a reload reuses it. `503 case-break-unavailable` is retried by the outbox ("Case break saved on this device"); `case-break-rejected` keeps the task and says what to check. `claim-next` does not list BREAK_CASE in the published `AnyTaskType`, so there is no pull button for it yet (see [API contract](api-contract.md#gaps-in-the-published-spec-worth-a-fix-in-fulfillment-execution)).

A fixed side is sent with the planned spelling, so a lower-case manual entry cannot trip the service's equality check.

## Lease semantics

- The service grants 5 minutes by default. The client learns the lease length at claim time (`leaseExpiry` minus the response `Date`), falling back to 5 minutes, and keeps the deadline in the **local** clock, so device clock skew cannot corrupt the countdown.
- At half-life (or less) the client calls `POST /tasks/{id}/renew-lease` (`204`, no body). It retries a failed renewal no more often than every 10 s. A successful renewal resets the local deadline to a full lease.
- `409 task-not-claimed` / `task-not-owner` or `404 task-not-found` on renew or complete means the claim is gone: the task is dropped and the operator is told to pull again.
- `409 task-already-completed` on complete is treated as done.
- Complete while offline is saved and replayed (see [offline and idempotency](offline-and-idempotency.md)); the task screen shows "Completion saved on this device".
