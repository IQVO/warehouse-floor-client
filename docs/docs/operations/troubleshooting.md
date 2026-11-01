---
id: troubleshooting
title: Troubleshooting
sidebar_label: Troubleshooting
---

# Troubleshooting

The client has no server-side logic of its own, so almost every failure is
visible in the browser. Start with DevTools: the **Network** tab shows which
request failed and what answered it (Kong, this nginx, or nothing), the
**Console** tab shows lines prefixed `[floor]` (from `src/lib/log.ts`), and
**Application → Local Storage** shows `wfc.outbox.v1` (undelivered commands)
and `wfc.station.v1` (station session). The operator never sees raw JSON or a
status code, so the screen text is a hint, not a diagnosis; see the message
table in [API contract](/docs/ecosystem/api-contract).

## Operator sees an unexpected message

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| "The floor service cannot be reached at this address. This is a setup problem" | A `404`/`405` that is not a service problem: the edge did not route `/api/<context>` to Kong. This nginx answers `/api/` with `404` problem+json "No API at this address" on purpose | Network tab: response body contains `No API at this address`, or is an HTML page | route `/api` to Kong at the page's own host (see [Runbook](./runbook.md)); in dev check `FLOOR_API_TARGET` |
| "The floor service is not answering properly" | `5xx` that is not `429/502/503/504` (those are retried silently), or a gateway HTML page | Network tab → status and body | check the owning service behind Kong; the client has nothing to fix |
| "The server could not be reached. Your ... is saved on this device." | the request failed at network level (no HTTP answer), timed out after 15 s, or the edge replied `429/502/503/504` | Network tab: request cancelled or `5xx`; `[floor] request did not reach the edge` / `edge asked us to retry` in the console | nothing to do for the operator; the outbox replays when the edge answers. If it persists, fix the edge or Kong |
| "You are offline. Your ... is saved on this device." | the browser reports no network | banner "You are offline" | restore Wi-Fi; replay is automatic |
| Banner "Sending saved actions: N saved actions are waiting" never clears | the oldest outbox entry keeps failing with a retryable answer, and replay stops at the first stuck command to keep order | Local Storage `wfc.outbox.v1`: first entry, its `attempts` and `path`; Network tab: the status it gets | fix the edge or service that answers `5xx`/`429`; "Retry now" replays immediately. Last resort: delete `wfc.outbox.v1`, which **discards** the saved commands |
| "The system does not know that barcode" / "That is not the item for this pick" on a PICK scan | the scanned GTIN is unknown to fulfillment-execution, or belongs to another SKU or pack level | `[floor] command rejected pick-scan 4xx <code>` in the console | rescan the right item or case; nothing was counted |
| "The request could not be matched to your last action" | `idempotency-key-required` or `-reused`: the service saw a missing key, or a key with a different body | Network tab: request has `Idempotency-Key`? | reload and retry; if the key is missing a screen bypassed the runner, which is a bug |
| "An extra task was claimed when the connection came back" | a `claim-next` was saved offline, replayed after the operator had already claimed another task. fulfillment-execution does not deduplicate `claim-next` by key | the warning is shown by design | ignore the extra task: its lease lapses back to the pool |
| "This task was already completed" after tapping Complete | the first completion reached the service but its answer was lost; the replay got `409 task-already-completed`, which the client treats as success | none needed | pull the next task |
| "You no longer hold this task" | the lease ran out, or another station took the task (`task-not-claimed`, `task-not-owner`, `task-not-found`); the client drops the held task | `renew-lease` failing in the Network tab before it | pull the next task; check that renewal is not blocked (see lease rows below) |

## Station and lease

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| "This station is not registered with the system" | `station-not-found`: the service restarted or lost its in-memory stations | Network tab: `claim-next` or `check-in` → `404` | use "Register this station again" on the station screen |
| Check-in answers "Someone is already checked in" | `station-occupied`; also seen when a `check-in` replay lands after the first one was applied | station screen shows operator | check the other person out, or use another station |
| Countdown turns to "Could not renew" | `renew-lease` cannot reach the edge. It is never queued; it is retried every 10 s from half-life | Network tab: `renew-lease` failing | restore connectivity before the claim runs out; otherwise the claim lapses |
| Lease length looks wrong | the length is `leaseExpiry` minus the response `Date`; outside 10 s to 60 min it falls back to 5 min | claim response `leaseExpiry` and `Date` | none; the client works in the local clock so device clock skew does not matter |
| "Cannot finish here" on the task screen | the held task type has no confirmation plan in this version (PACK, SLAM, REBIN, DISPATCH, ARRIVAL) | the task type in the header | ask the lead to move the task; the lease keeps renewing while the page is open |
| Task screen says "No task in hand" after a reload | `wfc.station.v1` was cleared, or its `held` section failed validation (`loadPersisted` drops it) | Local Storage | pull the next task |

## Scanning

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| A scan is ignored | same value twice within 400 ms is one scan (scanner bounce), or the value is longer than 128 characters, or empty after control characters are stripped | `src/lib/scan.ts` | rescan after a moment |
| Scanner types into nothing | focus is on a button or another field; `ScanInput` re-takes focus only when it fell on the page background | click the scan field | use "Type instead" for a keyboard and an on-screen Enter |
| Soft keyboard covers the screen | `ScanInput` sets `inputMode="none"` in scan mode | tap "Type instead" only when needed | tap "Back to scanning" |
| "Misread" on a GS1 label, nothing sent | the GS1 parser (`src/lib/gs1`) rejects a wrong check digit before any request | the SSCC/GTIN check digit | rescan or key the digits in manually; do not use the OpenAPI example SSCC `340123450000000013` (invalid check digit) |
| SSCC scanned in Cases/Items mode (or a GTIN in Carton mode) | the three-way choice sets the expected kind; a mismatch is refused on the device | the button selected | press the button that matches the barcode |

## Receiving

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| Receipt list is empty or cannot load | `GET /receipts?state=Open&limit=50` failed or returned no open receipts; only the first page is read | Network tab | open the receipt by its number instead |
| Scan accepted but a finding appears | not an error: the goods are here and the service reports a discrepancy (nine kinds) | [Receiving flow](/docs/overview/receiving-flow) | follow the "what to do" text |
| `DuplicateSscc` after a retried scan | the service did not deduplicate the replay by `Idempotency-Key` | Network tab: two `POST .../scans` with the same key and different answers | per the receiving flow page this is the documented symptom of a deployment that does not dedupe; report to inbound-receiving |
| Print label does nothing useful | the label uses `window.print()`; the service has no printer driver | browser print dialog | choose a printer; the print CSS shows only the label |
| Receipt cannot be reloaded offline | reads are plain `GET`s and are never cached or queued | banner shows offline | scans can still be taken and are queued |

## Offline shell and service worker

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| No offline app shell on a handheld | browsers only run service workers on `https` or `http://localhost`; an RF gun on `http://<lan-host>` runs without one. The outbox still works | Application → Service Workers is empty | serve the app over https for offline shell loading |
| Old UI after a deploy | a page that is already open keeps its JavaScript; the new worker takes over on the next navigation | Application → Service Workers → cache name `floor-shell-<hash>` | reload the page |
| Page stuck on an old version | `sw.js`/`index.html` cached by an intermediate proxy | `curl -sI <host>/sw.js` must show `Cache-Control: no-cache` | fix the proxy; nginx sends `no-cache` for `sw.js`, `index.html` and the manifest |
| No service worker in `npm run dev` | by design: registration happens only when `import.meta.env.PROD` is true | `npm run build && npm run preview` | test worker behaviour on a preview build |
| Commands vanished after clearing site data | the outbox lives in `localStorage` (`wfc.outbox.v1`) | n/a | nothing to recover; warn operators not to clear site data while "saved on this device" is shown |
| Outbox lost on every reload in a private window | `localStorage` throws, so `defaultStore()` falls back to memory | `[floor]` lines, empty Local Storage | do not run the floor client in a private-mode window |

## Local development and CI

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm ci` / `vite` cannot resolve `@warehouse/ui-kit` | `../warehouse-ui-kit` missing or unbuilt | clone it as a sibling, then `npm ci && npm run build` there |
| `npm run dev` exits: port 5174 in use | `strictPort: true` | free the port |
| `/api` calls return connection refused in dev | `FLOOR_API_TARGET` points at Kong (default `http://localhost:8000`) and the cluster is not running | start the cluster, or run `npm run stub-api` and set `FLOOR_API_TARGET=http://localhost:8787` |
| E2E flow cannot launch Chromium | Playwright browsers not installed | `npx playwright install chromium`, or set `E2E_CHROMIUM` |
| Lease renewal is skipped in `e2e:station` | the stub was started with the default 5-minute lease | start it with `STUB_LEASE_MS=20000` |
| Pick scan or break-case fails against the stub | the stub implements neither endpoint | use the unit tests (`PickScan.test.tsx`, `TaskScreen.test.tsx`) or a real fulfillment-execution |
| Vitest "Invalid hook call" or a null dispatcher | a second React instance from the ui-kit sibling | keep `resolve.dedupe: ["react", "react-dom"]` in `vite.config.ts` (vitest merges it) |
| Vitest throws `fetchStub: unhandled <METHOD> <url>` | `src/test/fetchStub.ts` throws on an unmatched request by design | add the route to the test's stub |
| Docker build: `Cannot find native binding` | building with the macOS-generated lockfile | build with the repo `Dockerfile`, which installs without the lockfile |
| CI `docs` fails | a broken link, an MDX error or a type error in `docs/` | run `make docs` (or `npm ci && npm run typecheck && npm run build` in `docs/`) |
| `docs` fails with an MDX error on `<name>` or `{id}` | a bare angle bracket or brace outside backticks | wrap it in backticks |
