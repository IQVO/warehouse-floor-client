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
| PICK | the order label (`orderRef`, case-insensitive) | no | `{stationId}` |
| RELOCATE | source bin, destination bin; a side the plan fixes must match it, an open side (source of an Assign, destination of a Vacate) accepts any scan | counted, >= 1 | `{stationId, quantity, fromBin, toBin}` |
| REPLENISH | reserve bin, pick face: must match the plan | counted, defaults to the planned quantity | `{stationId, quantity, fromBin, toBin}` |

A fixed side is sent with the planned spelling, so a lower-case manual entry cannot trip the service's equality check.

## Lease semantics

- The service grants 5 minutes by default. The client learns the lease length at claim time (`leaseExpiry` minus the response `Date`), falling back to 5 minutes, and keeps the deadline in the **local** clock, so device clock skew cannot corrupt the countdown.
- At half-life (or less) the client calls `POST /tasks/{id}/renew-lease` (`204`, no body). It retries a failed renewal no more often than every 10 s. A successful renewal resets the local deadline to a full lease.
- `409 task-not-claimed` / `task-not-owner` or `404 task-not-found` on renew or complete means the claim is gone: the task is dropped and the operator is told to pull again.
- `409 task-already-completed` on complete is treated as done.
- Complete while offline is saved and replayed (see [offline and idempotency](offline-and-idempotency.md)); the task screen shows "Completion saved on this device".
