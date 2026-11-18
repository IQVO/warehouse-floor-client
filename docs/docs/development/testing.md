---
id: testing
title: Testing
sidebar_label: Testing
---

# Testing

The test pyramid of a small front end: many fast unit and component tests under
vitest, one hand-run browser flow per slice against an in-memory stub, and CI
gates for lint, file length, the agent guides, types, build and this
documentation site. `npm test` runs with coverage and fails under the
thresholds in `vitest.config.ts` (statements 90, branches 83, functions 91,
lines 94). There are no contract, mutation or fitness jobs in this repo, and
the browser flows are not part of CI.

## The pyramid as it is

| Layer | Tooling | Where | Runs in CI |
|---|---|---|---|
| Unit (pure logic, no React) | vitest, jsdom | `src/lib/*.test.ts`, `src/lib/gs1/gs1.test.ts`, `src/lib/barcode/barcode.test.ts`, `src/api/problemMessages.test.ts`, `src/api/yardManagement.test.ts`, `src/features/task/confirmPlan.test.ts`, `src/features/yard/checkInRules.test.ts`, `yardFormat.test.ts`, `yardScan.test.ts`, `src/pwa/register.test.ts` | yes (`test`) |
| Service worker | vitest, evaluating `public/sw.js` in a `node:vm` sandbox with a fake worker scope and Cache API | `src/pwa/sw.test.ts` | yes (`test`) |
| Component / screen | vitest + Testing Library + user-event | `src/components/ScanInput.test.tsx`, `src/components/StuckOutboxBanner.test.tsx`, `src/features/station/StationScreen.test.tsx`, `src/features/task/TaskScreen.test.tsx`, `src/features/task/PickScan.test.tsx`, `src/features/receiving/ReceivingScreen.test.tsx`, `src/features/yard/GateScreen.test.tsx`, `HostlerScreen.test.tsx`, `DockScreen.test.tsx`, `src/app/SettledNotices.test.tsx` | yes (`test`) |
| Stub over HTTP | vitest spawning `scripts/stub-api.mjs` on a free port | `src/test/stubApi.test.ts` | yes (`test`) |
| Browser flow | Playwright (Chromium) against `npm run dev` and the stub API | `scripts/e2e-station-flow.mjs`, `scripts/e2e-receiving-flow.mjs`, `scripts/e2e-yard-flow.mjs` | no, run by hand |
| Static checks | oxlint, `tsc -b --noEmit` (strict, `noUncheckedIndexedAccess`) | whole repo | yes (`lint`, `typecheck`) |
| Production build | `tsc -b && vite build` plus the precache stamp | whole repo | yes (`build`) |
| Docs build | Docusaurus: typecheck and build, which fails on broken links and MDX errors | `docs/` | yes (`docs`) |

Size today: 26 test files, 424 tests, all passing. The numbers are the ones `npm test`
prints (`Test Files` / `Tests`), so every `it.each` row counts as a test; the
per-file column is the same run through `--reporter=json`:

| File | Tests |
|---|---|
| `src/api/yardManagement.test.ts` | 43 |
| `src/features/yard/GateScreen.test.tsx` | 35 |
| `src/lib/gs1/gs1.test.ts` | 34 |
| `src/lib/outboxMigration.test.ts` | 33 |
| `src/api/problemMessages.test.ts` | 32 |
| `src/features/task/PickScan.test.tsx` | 24 |
| `src/lib/lib.test.ts` | 21 |
| `src/lib/barcode/barcode.test.ts` | 20 |
| `src/features/receiving/ReceivingScreen.test.tsx` | 18 |
| `src/features/yard/HostlerScreen.test.tsx` | 16 |
| `src/features/task/TaskScreen.test.tsx` | 15 |
| `src/features/yard/checkInRules.test.ts` | 15 |
| `src/app/SettledNotices.test.tsx` | 14 |
| `src/test/stubApi.test.ts` | 14 |
| `src/features/yard/DockScreen.test.tsx` | 13 |
| `src/pwa/sw.test.ts` | 12 |
| `src/components/ScanInput.test.tsx` | 10 |
| `src/features/task/confirmPlan.test.ts` | 10 |
| `src/features/station/StationScreen.test.tsx` | 9 |
| `src/lib/scan.test.ts` | 8 |
| `src/features/yard/yardScan.test.ts` | 7 |
| `src/lib/outboxRetry.test.ts` | 6 |
| `src/features/yard/yardFormat.test.ts` | 4 |
| `src/lib/settledHandled.test.ts` | 4 |
| `src/pwa/register.test.ts` | 4 |
| `src/components/StuckOutboxBanner.test.tsx` | 3 |

The `vitest.config.ts` merges `vite.config.ts` and sets `environment: "jsdom"`,
`globals: true`, `css: false`, `setupFiles: ["./src/test/setup.ts"]` and
`include: ["src/**/*.test.{ts,tsx}"]`. The setup file registers
`@testing-library/jest-dom` matchers and, after every test, unmounts the tree
and clears `localStorage`.

## What the tests pin

| Area | Test | Pinned behaviour |
|---|---|---|
| Idempotency-Key | `src/lib/lib.test.ts` | one key per action; reuse on replay, reload and identical re-tap; new key when the body changes; persisted before the request; FIFO replay stops at the first stuck command; `429/502/503/504` retried, other statuses final |
| Offline shell | `src/pwa/sw.test.ts` | non-GET, `/api/` and cross-origin requests are not intercepted; shell files are cache-first; navigations are network-first with the cached `index.html` as fallback; old `floor-shell-*` caches are deleted on activate |
| Service worker registration | `src/pwa/register.test.ts` | registered only when enabled and supported; failure is logged, not thrown |
| Operator messages | `src/api/problemMessages.test.ts` | known codes map to what-and-what-to-do text; a gateway HTML `404` is a setup problem and a `5xx` "not answering"; an unknown code falls back to the service's own title; a queued action says it need not be repeated |
| Scan input | `src/components/ScanInput.test.tsx`, `src/lib/scan.test.ts` | focus on mount and when dropped on nothing, never stolen from another field; Enter-terminated scans; bounced trigger is one scan; control characters stripped; "Type instead" fallback |
| Station | `StationScreen.test.tsx`, `TaskScreen.test.tsx` | register, check-in by badge scan, claim, check-out; `no-claimable-task`, `station-not-found`, `station-occupied`, `station-not-occupied` copy; lease countdown and half-life renewal with its own key (fake timers); `task-not-claimed` drops the task; `task-already-completed` is success; completion saved offline and replayed with the same key, also after a reload |
| Pick and case break | `PickScan.test.tsx`, `confirmPlan.test.ts` | each pick scan posts `{stationId, gtin, count: 1}` with its own key; GS1-128 case label sends only the GTIN-14; `task-not-owner` drops the task; offline and reload replay with the saved key; `case-breaks` screen, `case-break-unavailable` retried; completion plans for PICK, RELOCATE, REPLENISH and "not finished in this release" for PACK, SLAM, REBIN, DISPATCH, ARRIVAL |
| Receiving | `ReceivingScreen.test.tsx`, `gs1.test.ts`, `barcode.test.ts` | open receipts list; SSCC, case and each scans with their own keys; cases are never multiplied on the device; scans refused before any request; mixed-carton audit; refused scan versus finding; `CartonOverLimit` and `UnlabelledCarton` (label fetched and printed); offline scan replay |
| Yard | `yardManagement.test.ts`, `yardScan.test.ts`, `checkInRules.test.ts`, `GateScreen.test.tsx`, `HostlerScreen.test.tsx`, `DockScreen.test.tsx` | every yard command: same-origin path, key, documented body, same key on a second tap and across a reload; check-in trailer rules (one with an appointment, one or more without, none for bobtail/pickup); GS1 barcodes refused as yard labels; `REJECTED` visit shown as turned away; every problem slug of the yard calls has operator copy (`SLUGS`), and `carrier-suspended` reads as a recorded turn-away with no retry advice; check-out ticks, drop vs live vs pickup; claim, deviation needs a reason, `location-occupied`, `not-lease-holder`, reload adopts/drops the held move, lease run-out; door-work steps and load state; visiting-driver move completed with no `hostlerRef`; lists follow `nextCursor` |
| Seal strength at check-in | `checkInRules.test.ts`, `yardManagement.test.ts`, `GateScreen.test.tsx` | `trailers[].sealClass` is `I`, `S` or `H` next to a seal number; the property is absent (no `""`, no `null`) when not stated and when there is no seal; a value outside the enum is refused on the device; the choice shows only with a seal number, in words, and goes when the number is cleared; a queued check-in with and without the field is stored whole and replays the same body with the same key after a reload; an entry stored by a build that did not know the field loads untouched (store string unchanged) and replays with its original key; `seal-class-too-low` keeps the form, and the corrected request carries the class under a new key; `invalid-seal-class` has copy |
| Turned away by the service | `GateScreen.test.tsx`, `yardManagement.test.ts` | after `409 carrier-suspended` on the truck in the form: the form and its button are gone, the message has no Dismiss, the card survives a look at Reject, exactly one `POST /visits` was sent, and **Start the next truck** opens an empty form; the same when the 409 arrives on a replay and that truck is still in the form; a replay for an **earlier** truck is announced by plate and the truck being typed keeps every field and is sent once; a reload (empty form) and the same plate at another site do not take the form; two saved check-ins turned away one after another are both named; the outbox is empty and nothing is sent again on later flushes; any other refusal keeps the form |
| Who shows a replayed answer | `src/lib/settledHandled.test.ts`, `src/app/SettledNotices.test.tsx` | runner: a listener that returns `true` silences the fallback, none does and the fallback hears it once, an awaited answer goes to the caller only; app: a yard check-in turned away while the operator is on the station screen (seeded and after walking there) or on the hostler screen is one global notice in the yard's words naming the truck, never "Try again", and stays across screens until dismissed; with the gate in view the card only; a receiving scan refused with another receipt open or on another screen is one global notice in receiving's words naming the receipt; with its own receipt open the screen only; a fulfillment command is answered by the station flow as before; off-screen check-in directions, `REJECTED` visit, scan finding and claim are said, plain confirmations are not; two refusals are both kept |
| Stub API | `src/test/stubApi.test.ts` | spawns `scripts/stub-api.mjs` and drives every yard endpoint over HTTP: shapes against the OpenAPI's required properties, problem slugs, idempotent replay, paging, lease sweep; the site policy's `minimumSealClass` (`seal-class-too-low` for a lower class or none, a sufficient class admitted, no seal not judged, nothing persisted on a refusal), `invalid-seal-class`, a class with no seal number; `suspendedCarrierAction` `NONE` / `FLAG` / `REJECT` (one `REJECTED` visit with reason `CARRIER_SUSPENDED` and no trailer per request, then the 409; the carrier rule before the seal rule) |

## Test approach

- **Fetch stub, not msw.** `src/test/fetchStub.ts` is a routed `fetch`
  stand-in; an unmatched request throws `fetchStub: unhandled <METHOD> <url>`,
  so a new endpoint cannot sneak in unstubbed. Fixtures are shaped from the
  OpenAPI examples of the owning services.
- **Per screen: a happy path and a problem+JSON path**, plus the offline and
  reload cases for commands.
- `src/test/renderApp.tsx` builds a fresh services set (store, outbox,
  runner) per test; reusing the store simulates a page reload.
- Lease tests use fake timers.
- The service worker is tested by evaluating `public/sw.js` in a sandbox.

## Make targets and npm scripts

| Command | What |
|---|---|
| `make check` | `lint typecheck test build docs`: what CI runs (also `check-all`) |
| `make check-fast` | `lint typecheck` only |
| `make lint` / `npm run lint` | `oxlint` |
| `make typecheck` / `npm run typecheck` | `tsc -b --noEmit` over the app, node and test projects |
| `make test` / `npm test` | `vitest run --coverage`, failing under the thresholds of `vitest.config.ts` |
| `npm run test:watch` | `vitest` in watch mode |
| `make build` / `npm run build` | `tsc -b && vite build` and the precache stamp |
| `make docs` | in `docs/`: `npm ci`, `npm run typecheck`, `npm run build` |
| `make e2e` | `npm run e2e:station`, `npm run e2e:receiving`, then `npm run e2e:yard` |
| `make stub-api` / `npm run stub-api` | the in-memory API on `:8787` |
| `make image` | `docker build --build-context uikit=../warehouse-ui-kit ...` |

## Running a single test

```bash
npx vitest run src/lib/lib.test.ts
npx vitest run -t "reuses the SAME key"
npx vitest run src/features/task
```

## Browser flows against the stub

```bash
STUB_LEASE_MS=20000 npm run stub-api &                      # :8787
FLOOR_API_TARGET=http://localhost:8787 npm run dev &        # :5174
npm run e2e:station                                         # headless Chromium
npm run e2e:receiving                                       # carton, over-limit, unlabelled, lost answer
npm run e2e:yard                                            # gate check-in (lost answer, same key), dock door work, check-out, hostler with a reason, reject,
                                                            # minimum seal strength (refused, then admitted with the class), suspended carrier (turned away once, online and on a replay)
                                                            # an earlier truck's replayed turn-away leaves the typed truck alone; a replay answered on another screen is said there once
E2E_MODE=real npm run e2e:station                           # against Kong (needs the cluster); never completes real work
```

Each script prints one `PASS`/`FAIL` line per verified behaviour, exits
non-zero on the first failure and saves screenshots under `e2e-shots/`
(`E2E_SHOTS`). Variables are in [Configuration](/docs/operations/configuration).

The stub enforces `Idempotency-Key` on every `POST` and replays the stored
answer for a repeated key (stricter than the real fulfillment-execution, which
does so on `POST /tasks` only), and can apply a command and then cut the
connection (`POST /__stub/drop-next-response`) to prove the client reuses its
key. It does not implement the pick-scan and `case-breaks` endpoints; those are
covered by the unit and screen tests only.

The yard stub starts like a site that set no gate rule. Two levers of the site
yard policy (yard-management ADR 0012 and 0016) are switched by hand, and
`POST /__stub/reset` puts them back:

```bash
# a minimum seal strength, and suspended carriers turned away
curl -X POST localhost:8787/__stub/yard-policy -H 'Content-Type: application/json' \
  -d '{"minimumSealClass":"S","suspendedCarrierAction":"REJECT"}'
```

- `minimumSealClass` (`null`, `I`, `S`, `H`): at the gate, a trailer with a seal
  number and a strength below it, or not stated, is `409 seal-class-too-low`;
  state **Security seal (S)** or stronger and it is admitted. A trailer with no
  seal is not judged.
- `suspendedCarrierAction` (`NONE`, `FLAG`, `REJECT`): the stub's carrier copy
  holds one suspended carrier, code **SUSP**. Under `REJECT`, a check-in with
  carrier code `SUSP` records a `REJECTED` visit (`CARRIER_SUSPENDED`, no
  trailer) and answers `409 carrier-suspended`; see it with
  `curl 'localhost:8787/api/yard-management/visits?siteId=WH1&state=REJECTED'`.
  `FLAG` admits the visit with `carrierFlag: SUSPENDED`.

`npm run e2e:yard` sets both, drives the two paths and sets them back.

## CI jobs (`.github/workflows/ci.yml`)

Like warehouse-console, CI checks out this repo and `IQVO/warehouse-ui-kit@develop`
as siblings and builds the kit before `npm ci`. Runs on push and pull request
to `develop` and `main`.

| Job | Runs |
|---|---|
| `lint` | Node 22; ui-kit `npm ci && npm run build`; `npm ci`; `npm run lint` |
| `file-length` | on a pull request into `develop`: `oxlint@1.90.0 -c .oxlintrc.file-length.json` over the `.ts`/`.tsx` files the PR adds or touches (300 code lines at most; tests, `docs/` and `*.d.ts` ignored), after a self-test of the gate |
| `guide-lint` | `python3 scripts/harness/guide_lint.py`, `repo_lint.py`, `test_hook.py`, `test_red_issue.py`, `test_repo_lint.py` |
| `test` | same setup as `lint`; `npm test` (with the coverage thresholds) |
| `typecheck` | same setup; `npm run typecheck` |
| `build` | same setup; `npm run build` |
| `docs` | Node 20, working directory `docs/`: `npm ci`, `npm run typecheck`, `npm run build` (cache `docs/package-lock.json`) |

Other workflows:

| Workflow | Runs |
|---|---|
| `codeql.yml` | CodeQL `javascript-typescript`, `security-extended`, on push, pull request and weekly (Monday 07:00 UTC) |
| `docs.yml` | builds the site on pull requests touching `docs/**` or `apis/**`; deploys to GitHub Pages on push to `main` |

The job names `lint`, `test`, `typecheck`, `build` and `docs` are the
branch-protection contract; do not rename them. The console's `trivy-fs-scan`,
Helm and publish jobs are not replicated: there is no chart and no registry
publish in this repo.

## Adding a test

- A new API error code: add copy to `BY_CODE` in `src/api/problemMessages.ts`
  (or `src/api/receivingMessages.ts`), a case in the matching test, and a row
  in [API contract](/docs/ecosystem/api-contract).
- A new command: build its `CommandSpec` in `src/api/*`, give it a `dedupeId`,
  and test happy path, problem path and offline replay with the shared
  `renderApp` helper.
- Never pass request-derived data to `console.*`; go through `log`
  (`src/lib/log.ts`).
