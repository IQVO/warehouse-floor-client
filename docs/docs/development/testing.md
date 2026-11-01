---
id: testing
title: Testing
sidebar_label: Testing
---

# Testing

The test pyramid of a small front end: many fast unit and component tests under
vitest, one hand-run browser flow per slice against an in-memory stub, and CI
gates for lint, types, build and this documentation site. There are no
contract, mutation, fitness or coverage-threshold jobs in this repo, and the
browser flows are not part of CI.

## The pyramid as it is

| Layer | Tooling | Where | Runs in CI |
|---|---|---|---|
| Unit (pure logic, no React) | vitest, jsdom | `src/lib/*.test.ts`, `src/lib/gs1/gs1.test.ts`, `src/lib/barcode/barcode.test.ts`, `src/api/problemMessages.test.ts`, `src/features/task/confirmPlan.test.ts`, `src/pwa/register.test.ts` | yes (`test`) |
| Service worker | vitest, evaluating `public/sw.js` in a `node:vm` sandbox with a fake worker scope and Cache API | `src/pwa/sw.test.ts` | yes (`test`) |
| Component / screen | vitest + Testing Library + user-event | `src/components/ScanInput.test.tsx`, `src/features/station/StationScreen.test.tsx`, `src/features/task/TaskScreen.test.tsx`, `src/features/task/PickScan.test.tsx`, `src/features/receiving/ReceivingScreen.test.tsx` | yes (`test`) |
| Browser flow | Playwright (Chromium) against `npm run dev` and the stub API | `scripts/e2e-station-flow.mjs`, `scripts/e2e-receiving-flow.mjs` | no, run by hand |
| Static checks | oxlint, `tsc -b --noEmit` (strict, `noUncheckedIndexedAccess`) | whole repo | yes (`lint`, `typecheck`) |
| Production build | `tsc -b && vite build` plus the precache stamp | whole repo | yes (`build`) |
| Docs build | Docusaurus: typecheck and build, which fails on broken links and MDX errors | `docs/` | yes (`docs`) |

Size today: 13 test files with 169 `it(...)`/`test(...)` calls (counted by
pattern, so `it.each` rows are counted once):

| File | Cases |
|---|---|
| `src/lib/gs1/gs1.test.ts` | 34 |
| `src/lib/lib.test.ts` | 21 |
| `src/lib/barcode/barcode.test.ts` | 20 |
| `src/features/receiving/ReceivingScreen.test.tsx` | 16 |
| `src/features/task/TaskScreen.test.tsx` | 15 |
| `src/features/task/PickScan.test.tsx` | 13 |
| `src/components/ScanInput.test.tsx` | 10 |
| `src/features/station/StationScreen.test.tsx` | 9 |
| `src/pwa/sw.test.ts` | 9 |
| `src/lib/scan.test.ts` | 8 |
| `src/features/task/confirmPlan.test.ts` | 6 |
| `src/api/problemMessages.test.ts` | 4 |
| `src/pwa/register.test.ts` | 4 |

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
| Pick and case break | `PickScan.test.tsx`, `confirmPlan.test.ts` | each pick scan posts `{stationId, gtin, count: 1}` with its own key; GS1-128 case label sends only the GTIN-14; `task-not-owner` drops the task; offline and reload replay with the saved key; `break-case` screen, `case-break-unavailable` retried; completion plans for PICK, RELOCATE, REPLENISH and "not finished in this release" for PACK, SLAM, REBIN, DISPATCH, ARRIVAL |
| Receiving | `ReceivingScreen.test.tsx`, `gs1.test.ts`, `barcode.test.ts` | open receipts list; SSCC, case and each scans with their own keys; cases are never multiplied on the device; scans refused before any request; mixed-carton audit; refused scan versus finding; `CartonOverLimit` and `UnlabelledCarton` (label fetched and printed); offline scan replay |

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
| `make test` / `npm test` | `vitest run` |
| `npm run test:watch` | `vitest` in watch mode |
| `make build` / `npm run build` | `tsc -b && vite build` and the precache stamp |
| `make docs` | in `docs/`: `npm ci`, `npm run typecheck`, `npm run build` |
| `make e2e` | `npm run e2e:station` then `npm run e2e:receiving` |
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
E2E_MODE=real npm run e2e:station                           # against Kong (needs the cluster); never completes real work
```

Each script prints one `PASS`/`FAIL` line per verified behaviour, exits
non-zero on the first failure and saves screenshots under `e2e-shots/`
(`E2E_SHOTS`). Variables are in [Configuration](/docs/operations/configuration).

The stub enforces `Idempotency-Key` on every `POST` and replays the stored
answer for a repeated key (stricter than the real fulfillment-execution, which
does so on `POST /tasks` only), and can apply a command and then cut the
connection (`POST /__stub/drop-next-response`) to prove the client reuses its
key. It does not implement the pick-scan and `break-case` endpoints; those are
covered by the unit and screen tests only.

## CI jobs (`.github/workflows/ci.yml`)

Like warehouse-console, CI checks out this repo and `IQVO/warehouse-ui-kit@develop`
as siblings and builds the kit before `npm ci`. Runs on push and pull request
to `develop` and `main`.

| Job | Runs |
|---|---|
| `lint` | Node 22; ui-kit `npm ci && npm run build`; `npm ci`; `npm run lint` |
| `test` | same setup; `npm test` |
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
