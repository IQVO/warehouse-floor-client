# API contract (fulfillment-execution)

Source of truth: `apis/openapi.yaml` in IQVO/fulfillment-execution (read from `origin/develop`). All paths are under `/api/fulfillment-execution` at this app's own origin (Kong).

## Endpoints used

| Action | Request | Success | Notes |
|---|---|---|---|
| Register | `POST /stations` `{stationId, capabilities[], locationCode?}` | `201` `Station` | upsert by `stationId` |
| Check in | `POST /stations/{id}/check-in` `{occupantId}` | `200` `Station` | |
| Check out | `POST /stations/{id}/check-out` (no body) | `200` `Station` | |
| Claim next | `POST /stations/{id}/claim-next` `{taskType}` | `200` `Task` (CLAIMED, `leaseStationId`, `leaseExpiry`) | `AnyTaskType`: PICK, PACK, SLAM, REBIN, DISPATCH, ARRIVAL, RELOCATE, REPLENISH |
| Renew lease | `POST /tasks/{id}/renew-lease` `{stationId}` | `204` | |
| Complete | `POST /tasks/{id}/complete` `{stationId, quantity?, fromBin?, toBin?}` | `204` | quantity/bins for RELOCATE and REPLENISH only; a BREAK_CASE task is refused (`case-break-completion-required`) |
| Scan-confirm (PICK) | `POST /tasks/{id}/scans` `{stationId, gtin, count?}` (`PickScanRequest`) | `200` `PickScanResult` `{scannedGtin, sku, level, addedEaches, pickedEaches, plannedEaches}` | `gtin` is the 14-digit GTIN (the pattern allows 8, 12, 13, 14); `count` = packs scanned: eaches for an EACH GTIN, **cases** for a CASE GTIN. The server multiplies by the pack factor, so quantities in the answer are eaches. The client always sends `count: 1` per physical scan |
| Break case (BREAK_CASE) | `POST /tasks/{id}/break-case` `{stationId}` | `204` | the service breaks the container in inventory-storage (its own `Idempotency-Key` is `break-case:<taskId>`), then completes the task. `503 case-break-unavailable` when inventory-storage is down: the task stays claimed |

`Station` is `{id, capabilities[], occupied, locationCode?}`. Every command also sends `Idempotency-Key`.

### Scans and the GS1 parser (contract R13/R14)

`src/lib/gs1/` is a pure parser (no network): `parseScan(raw)` returns `SSCC | GTIN | GS1_ELEMENTS | INVALID` with a machine `reason` on INVALID. It accepts symbology identifiers `]E0`/`]E4` (EAN-13, UPC-A, 8-digit), `]I1` (ITF-14), `]C1` (GS1-128, FNC1 = GS `0x1D`), the bare digits (8/12/13/14 = GTIN, 18 = SSCC) and the typed form `(01)...(10)...`. AIs read: 00 SSCC-18, 01 GTIN-14, 02 content GTIN, 37 count, 10 lot (up to 20, ended by GS unless last), 17 expiry (YYMMDD, day `00` = last day of the month). GS1 mod-10 check digits are validated, a GTIN is normalised to 14 digits, indicator digit 9 (variable measure) is refused, 01 and 02 never together, 02 needs 00 and 37. `normalizeScan` keeps the GS character; without it a lot cannot be told from the AI after it.

The PICK scan field takes a GTIN (bare, or AI 01 of a GS1-128; lot, expiry and AI 37 are ignored): an SSCC, a logistic label (AI 02) or an unreadable code is refused on the device with no request. The client **never multiplies and never sends a quantity with a new meaning**: a case scan is `count: 1` case. Whether the GTIN is the each or the case level, and whether it belongs to the task's SKU, is the service's call (`scan-level-mismatch`, `scan-sku-mismatch`).

Scans are **not de-duplicated by the server** (it ignores `Idempotency-Key` on task endpoints): each physical scan is its own outbox command with its own key (two scans of one case count twice), and a replay of a scan whose answer was lost could count it again. `pick-over-quantity` is the guard that stops that overshooting the plan. The running total shown to the operator comes from the latest answer, so it is blank after a reload until the next scan.

### Gaps in the published spec (worth a fix in fulfillment-execution)

- `TaskResponse` does not expose the pick plan (SKU, planned eaches, unit) or the case break (LPN, loose bin), so the screens cannot show what to pick or which case to open; they show the total reported by the scans answer.
- `AnyTaskType` (claim-next) does not list `BREAK_CASE`, and the service rejects `claim-next` for it. The client therefore does not offer a "Break case" pull button; the screen renders a BREAK_CASE task whenever one is held (`type === "BREAK_CASE"`).
- `PickScanRequest` documents a bad check digit as `404 invalid-scanned-gtin`, but the 409 description and examples say 409; the client keys on the code, not the status.


## Errors

Every error is `application/problem+json` with `type` (`https://errors.fulfillment-execution.warehouse-systems.dev/<code>`), `title`, `status`, `detail`, optional `instance`. The client keys on `<code>`. It never shows `detail` or raw JSON.

| Code | Status | Where | The operator sees (what / what to do) |
|---|---|---|---|
| `station-not-found` | 404 | claim, check-in/out | This station is not registered with the system. / Register the station again, then retry. |
| `no-claimable-task` | 409 | claim | No work is waiting for this station right now. / Nothing is wrong. Wait a moment and ask again. |
| `station-occupied` | 409 | check-in | Someone is already checked in at this station. / Ask them to check out, or use another station. |
| `station-not-occupied` | 409 | check-out | Nobody is checked in at this station. / Check in first. (the screen resyncs) |
| `task-not-found` | 404 | renew, complete, scan, break-case | The system does not know this task any more. / Pull the next task. |
| `task-not-claimed` | 409 | renew, complete, scan, break-case | You no longer hold this task... / Pull the next task. (task dropped) |
| `task-not-owner` | 409 | renew, complete, scan, break-case | Another station now holds this task. / Pull the next task. (task dropped) |
| `task-already-completed` | 409 | complete, break-case | This task was already completed. / Pull the next task. (treated as done) |
| `invalid-request` | 400 | any | The system could not accept that... / Check what you scanned or typed and try again. |
| `idempotency-key-required` / `-reused` | 400 / 422 | any | The request could not be matched to your last action. / Reload and try again. |
| `station-location-not-workcenter` | 422 | register | That location is not a work center. / Scan a work-center location label, or leave it empty. |
| `relocation-confirmation-required` | 422 | complete | A move is finished with the counted quantity and the bin scans. / ... |
| `invalid-relocation-confirmation` | 422 | complete | The bins you scanned do not fit the planned move. / Rescan the bins shown on the task. |
| `not-relocation-task` | 422 | complete | (client bug) quantity/bins sent for another task type. / Call your lead. |
| `replenishment-confirmation-required` | 422 | complete | A replenishment is finished with the quantity you counted. / ... |
| `invalid-replenishment-confirmation` | 422 | complete | The quantity or a scanned bin does not fit the replenishment. / ... |
| `unknown-gtin` | 409 | scan | The system does not know that barcode. / Check you scanned the item or case for this pick, scan again. |
| `invalid-scanned-gtin` | 409 | scan | That barcode is not a valid product code. / Scan it again or use Type instead. Nothing counted. |
| `scan-sku-mismatch` | 409 | scan | That is not the item for this pick (maybe the each barcode printed on a case of something else). / Put it back and scan the right one. |
| `scan-level-mismatch` | 409 | scan | A case where single items are picked, or the reverse. / Scan the unit this pick asks for. |
| `pick-over-quantity` | 409 | scan | That scan would pick more than the task asks for; not counted. / Put the extra back; if complete, scan the order label and complete. |
| `no-pick-plan` | 409 | scan | This task has no pick quantity to scan against. / Scan the order label and complete, or ask your lead. |
| `case-break-rejected` | 409 | break-case | The storage system refused to break this case. / Check it is sealed and in its bin, try again. |
| `not-case-break-task` | 409 | break-case | This task is not a case-break task. / Pull the next task. |
| `case-break-completion-required` | 409 | complete | A case-break task is finished with the Break case button. / Use Break case. |
| `case-break-unavailable` | 503 | break-case | The storage system could not be reached; nothing changed. / Try again; the task is still yours. (`503` is retried by the outbox, so the operator normally sees "Case break saved on this device") |
| `internal-error` | 500 | any | The server hit an unexpected error. / Try again in a moment. |
| anything else, `about:blank` | any | any | gateway 404/405: "cannot be reached at this address" (setup problem); 5xx: "not answering properly"; unknown code: the service's own `title` plus "call your lead" |

The exact text lives in `src/api/problemMessages.ts` and is covered by `src/api/problemMessages.test.ts`. `429/502/503/504` are not shown as errors: they are retried (see [offline and idempotency](offline-and-idempotency.md)).

## Cluster routing (not wired by this repo)

In the kind cluster Kong listens on `http://localhost:8000` and the web gateway on `http://localhost:80` serves HTML only (it has no `/api` route, and answers any unknown path with the console's `index.html`). So `FLOOR_API_TARGET` defaults to Kong at `:8000` in dev. Serving this app in the cluster needs the edge to route `/api/*` to Kong on the same host; that infra change belongs to warehouse-infra and is not part of this repo.
