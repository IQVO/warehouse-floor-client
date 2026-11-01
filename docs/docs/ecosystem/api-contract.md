---
id: api-contract
title: API contract
sidebar_label: API contract
---

# API contract (fulfillment-execution)

Source of truth: `apis/openapi.yaml` in IQVO/fulfillment-execution (read from `origin/develop`). All paths are under `/api/fulfillment-execution` at this app's own origin (Kong). The client code is `src/api/fulfillmentExecution.ts`; the wider picture of every edge is on [Integration](./integration.md).

## Endpoints used

| Action | Request | Success | Notes |
|---|---|---|---|
| Register | `POST /stations` `{stationId, capabilities[], locationCode?}` | `201` `Station` | upsert by `stationId` |
| Check in | `POST /stations/{id}/check-in` `{occupantId}` | `200` `Station` | |
| Check out | `POST /stations/{id}/check-out` (no body) | `200` `Station` | |
| Claim next | `POST /stations/{id}/claim-next` `{taskType}` | `200` `Task` (CLAIMED, `leaseStationId`, `leaseExpiry`) | `AnyTaskType`: PICK, PACK, SLAM, REBIN, DISPATCH, ARRIVAL, RELOCATE, REPLENISH. The client offers PICK, RELOCATE, REPLENISH |
| Renew lease | `POST /tasks/{id}/renew-lease` `{stationId}` | `204` | never queued |
| Pick scan | `POST /tasks/{id}/scans` `{stationId, gtin, count}` | `200` `PickScanResult` `{scannedGtin, sku, level, addedEaches, pickedEaches, plannedEaches}` | `gtin` is the 14-digit form; `count` is packs scanned (the client sends 1 per physical scan; the server multiplies a case) |
| Break case | `POST /tasks/{id}/break-case` `{stationId}` | `204` | the `BREAK_CASE` task type, which `AnyTaskType` does not list yet |
| Complete | `POST /tasks/{id}/complete` `{stationId, quantity?, fromBin?, toBin?}` | `204` | quantity/bins for RELOCATE and REPLENISH only |

`Station` is `{id, capabilities[], occupied, locationCode?}`. Every command also sends `Idempotency-Key`.

## Errors

Every error is `application/problem+json` with `type` (`https://errors.fulfillment-execution.warehouse-systems.dev/<code>`), `title`, `status`, `detail`, optional `instance`. The client keys on `<code>`. It never shows `detail` or raw JSON.

| Code | Status | Where | The operator sees (what / what to do) |
|---|---|---|---|
| `station-not-found` | 404 | claim, check-in/out | This station is not registered with the system. / Register the station again, then retry. |
| `no-claimable-task` | 409 | claim | No work is waiting for this station right now. / Nothing is wrong. Wait a moment and ask again. |
| `station-occupied` | 409 | check-in | Someone is already checked in at this station. / Ask them to check out, or use another station. |
| `station-not-occupied` | 409 | check-out | Nobody is checked in at this station. / Check in first. (the screen resyncs) |
| `task-not-found` | 404 | renew, complete | The system does not know this task any more. / Pull the next task. |
| `task-not-claimed` | 409 | renew, complete | You no longer hold this task... / Pull the next task. (task dropped) |
| `task-not-owner` | 409 | renew, complete | Another station now holds this task. / Pull the next task. (task dropped) |
| `task-already-completed` | 409 | complete | This task was already completed. / Pull the next task. (treated as done) |
| `invalid-request` | 400 | any | The system could not accept that... / Check what you scanned or typed and try again. |
| `idempotency-key-required` / `-reused` | 400 / 422 | any | The request could not be matched to your last action. / Reload and try again. |
| `station-location-not-workcenter` | 422 | register | That location is not a work center. / Scan a work-center location label, or leave it empty. |
| `relocation-confirmation-required` | 422 | complete | A move is finished with the counted quantity and the bin scans. / ... |
| `invalid-relocation-confirmation` | 422 | complete | The bins you scanned do not fit the planned move. / Rescan the bins shown on the task. |
| `not-relocation-task` | 422 | complete | (client bug) quantity/bins sent for another task type. / Call your lead. |
| `replenishment-confirmation-required` | 422 | complete | A replenishment is finished with the quantity you counted. / ... |
| `invalid-replenishment-confirmation` | 422 | complete | The quantity or a scanned bin does not fit the replenishment. / ... |
| `unknown-gtin` | 4xx | pick scan | The system does not know that barcode. / Check you scanned the item or case for this pick, then scan it again. |
| `invalid-scanned-gtin` | 4xx | pick scan | That barcode is not a valid product code. / Scan it again or use Type instead. Nothing was counted. |
| `scan-sku-mismatch` | 4xx | pick scan | That is not the item for this pick. / Put it back and scan the item or case this pick asks for. |
| `scan-level-mismatch` | 4xx | pick scan | A case where items are picked, or the reverse. / Scan the unit this pick asks for. |
| `pick-over-quantity` | 4xx | pick scan | That scan would pick more than the task asks. Not counted. / Put the extra back; if complete, scan the order label and complete. |
| `no-pick-plan` | 4xx | pick scan | This task has no pick quantity to scan against. / Scan the order label and complete the task, or ask your lead. |
| `case-break-rejected` | 4xx | break case | The storage system refused to break this case. / Check the case is sealed and in its bin, then try again. |
| `not-case-break-task` | 4xx | break case | This task is not a case-break task. / Pull the next task; call your lead if it repeats. |
| `case-break-completion-required` | 4xx | complete | A case-break task is finished with Break case, not Complete. / Use Break case. |
| `case-break-unavailable` | 503 | break case | The storage system could not be reached. Nothing changed. / Try again; the task is still yours. (retried, not shown as a failure unless it stays) |
| `internal-error` | 500 | any | The server hit an unexpected error. / Try again in a moment. |
| anything else, `about:blank` | any | any | gateway 404/405: "cannot be reached at this address" (setup problem); 5xx: "not answering properly"; unknown code: the service's own `title` plus "call your lead" |

The exact text lives in `src/api/problemMessages.ts` and is covered by `src/api/problemMessages.test.ts`. `429/502/503/504` are not shown as errors: they are retried (see [offline and idempotency](/docs/overview/offline-and-idempotency)).

## Cluster routing (not wired by this repo)

In the kind cluster Kong listens on `http://localhost:8000` and the web gateway on `http://localhost:80` serves HTML only (it has no `/api` route, and answers any unknown path with the console's `index.html`). So `FLOOR_API_TARGET` defaults to Kong at `:8000` in dev. Serving this app in the cluster needs the edge to route `/api/*` to Kong on the same host; that infra change belongs to warehouse-infra and is not part of this repo.

## API contract (inbound-receiving)

Source of truth: `apis/openapi.yaml` in IQVO/inbound-receiving (`origin/develop`). All paths are under `/api/inbound-receiving`. Flow, copy per finding and retry rules: [Receiving flow](/docs/overview/receiving-flow).

| Action | Request | Success | Notes |
|---|---|---|---|
| List open receipts | `GET /receipts?state=Open&limit=50` | `200` `{items: Receipt[], nextCursor?}` | first page only |
| Get a receipt | `GET /receipts/{receiptId}` | `200` `Receipt` | |
| Receive by scan | `POST /receipts/{receiptId}/scans` `{kind, id, qty?, lot?, expiry?, countedContents?}` | `201` accepted / `200` refused with findings, both `ScanResult` | `Idempotency-Key` required. `qty` = cases for `CASE_GTIN`, eaches for `EACH_GTIN`. Fields exactly as `ReceiveScanRequest` (the raw-`scan` form is not used) |
| Close | `POST /receipts/{receiptId}/close` (no body) | `200` `Receipt` (Closed, with Short/Over/Damaged) | key optional in the spec, sent anyway |
| Carton label data | `GET /receipts/{receiptId}/cartons/{lpn}/label` | `200` `{lpn, symbology:"CODE128", humanReadable, sku?, units, receivedAt}` | `404 carton-not-found` |

Errors are `application/problem+json`, `type` = `https://errors.inbound-receiving.warehouse-systems.dev/<slug>`; the client keys on `<slug>` and never shows `detail`. Copy for the slugs a dock operator can meet is in `src/api/receivingMessages.ts` (`receipt-not-found`, `invalid-receipt-id`, `receipt-closed`, `scan-kind-mismatch`, `invalid-sscc`, `invalid-gtin`, `unsupported-gtin`, `unsupported-pack-level`, `invalid-scan(-kind)`, `invalid-cases`, `invalid-quantity`, `invalid-counted-contents`, `counted-contents-not-mixed`, `counted-sku-unknown`, `carton-not-found`, `version-mismatch`, `concurrent-modification`, `dependency-unavailable`, `malformed-request`); idempotency, 5xx and gateway answers fall back to the shared table above. `429/502/503/504` are retried, not shown.

Idempotency: inbound-receiving **does** de-duplicate `POST /scans` by `Idempotency-Key` (per its OpenAPI); see [Receiving flow](/docs/overview/receiving-flow#commands-keys-and-retries). Spec observation: its example SSCC has an invalid check digit.
