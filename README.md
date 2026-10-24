# warehouse-floor-client

Scan-first PWA for RF guns and station screens: the first-party client for the warehouse floor-execution APIs (claim, complete, pack, stow, shift clock).

This first cut is the foundation plus one slice, **fulfillment-execution stations**: register, check in/out, claim the next task, scan to confirm, keep the lease alive, complete.

| | |
|---|---|
| Stack | React 19, Vite 8, TypeScript (strict), React Router 7, `@warehouse/ui-kit` |
| Lint / test | oxlint, vitest + Testing Library (jsdom) |
| Runtime | static files behind nginx (`Dockerfile`, `nginx.conf`) |
| Docs | [`docs/`](docs/index.md) |

## Run it

The ui-kit is a sibling checkout, exactly as for `warehouse-console`:

```bash
cd ..                                   # the directory that holds warehouse-ui-kit
(cd warehouse-ui-kit && npm ci && npm run build)
cd warehouse-floor-client
npm ci
npm run dev                             # http://localhost:5174, /api proxied to Kong
```

| Command | What |
|---|---|
| `make check` | lint, typecheck, test, build, docs: what CI runs |
| `npm run dev` | dev server on :5174. `/api` is proxied to `FLOOR_API_TARGET` (default `http://localhost:8000`, Kong's host port in the kind cluster) |
| `npm run stub-api` | in-memory fulfillment-execution on :8787, shaped from the OpenAPI examples. Use with `FLOOR_API_TARGET=http://localhost:8787 npm run dev` |
| `npm run e2e:station` | drives the station flow in headless Chromium (needs the dev server + stub, or `E2E_MODE=real`) |
| `make image` | `docker build --build-context uikit=../warehouse-ui-kit ...` |

Browsers only run service workers on `https` or `http://localhost`. On plain `http://<lan-host>` the app works but without the offline app shell (the offline outbox still works: it needs no service worker).

## Rules this repo lives by

These are the conventions (there is no agent-guide file yet; this is the source of truth).

### 1. Kong only, same origin

The app talks to each owning context's REST **only** through Kong, at the page's own origin: `/api/<context>/...` (`/api/fulfillment-execution`, `/api/workforce-management`, `/api/inventory-storage`, ...). Relative paths, never an absolute URL, never a service host or port, no BFF, no runtime config file. In dev, Vite proxies `/api` (see `vite.config.ts`); in the cluster the edge must route `/api` to Kong at the same host that serves this app (`nginx.conf` answers `/api/` with a 404 problem+json so a mis-route is obvious, never an SPA-fallback `200`).

The fleet is unauthenticated by decision: no login, no tokens, no `Authorization` header.

### 2. Every command carries an `Idempotency-Key`

Every `POST`/`PUT` sends `Idempotency-Key`. The key identifies **one user action**, not one HTTP attempt:

- minted **once**, when the action is first submitted;
- written to the persisted outbox **before** the request is sent, so a reload cannot lose or replace it;
- **reused** on every retry: automatic replay, reconnect, reload, the operator tapping the button again (same action, same body);
- a different action, or the same action with a different body, gets a **new** key (the service answers `422 idempotency-key-reused` otherwise).

All of it lives in `src/lib/commands.ts` + `src/lib/outbox.ts`. A screen never builds a `fetch` for a command; it calls the runner. Details and edge cases: [docs/offline-and-idempotency.md](docs/offline-and-idempotency.md).

### 3. Offline: banner + persisted outbox, shell-only service worker

When the network is down the app shows a persistent **offline banner**, queues commands in the **outbox** (localStorage), and replays them FIFO with their original keys on reconnect. The service worker (`public/sw.js`) precaches the **app shell only**: it never intercepts a non-GET request or anything under `/api/`, so no command or API response is ever served from cache. This is tested (`src/pwa/sw.test.ts`).

**Why a hand-written worker and no `vite-plugin-pwa`/Workbox:** the policy is five lines of "do not touch" plus a cache-first lookup for a fixed list of files. A plugin would add a runtime-config surface (and a build-time dependency tree) larger than the code it replaces, and its defaults (runtime caching, navigation fallbacks) are exactly what must not happen to `/api`. `build/precacheManifest.ts` (a ~40-line Vite plugin) stamps the hashed file list into `dist/sw.js`. **Runtime dependencies are identical to the console's** (`react`, `react-dom`, `react-router-dom`, `@warehouse/ui-kit`); dev dependencies are the console's minus Module Federation and msw (tests use a plain fetch stub).

### 3b. Lease handling

Claims are leased (5 minutes by default). The task screen shows a visible countdown and calls `renew-lease` automatically at half-life. Renewals are fire-and-forget: never queued (a renewal replayed an hour later is noise), each with its own key.

### 4. Scan first

Barcodes enter through one component, `src/components/ScanInput.tsx`: a focus-locked input that captures keyboard-wedge input terminated by Enter, with a "Type instead" manual-entry fallback and an on-screen Enter. Controls are at least 56px tall (primary actions 72px). Do not add ad-hoc `<input>`s for scanned values.

### 5. Errors are for operators

A Problem+JSON response is turned into **what happened + what to do** in plain words (`src/api/problemMessages.ts`). Never render raw JSON, the HTTP status, or the service's `detail` string. Add the new error code to the table in [docs/api-contract.md](docs/api-contract.md) and to the test when the service gains one.

### 6. Logging

Never pass request-derived values (scanned codes, ids, paths, problem fields) to `console.*` directly. Use `log` from `src/lib/log.ts`: it flattens CR/LF and other control characters (log-injection) and truncates.

### 7. Git and CI

GitFlow: feature branch, one PR into `develop`, never push `develop` or `main`. CI job names `lint`, `test`, `typecheck`, `build`, `docs` (+ CodeQL) mirror `warehouse-console` and are what branch protection should require; do not rename them. The `docs` job is a zero-dependency Markdown gate (`scripts/docs-check.mjs`), not a Docusaurus site: see [docs/development.md](docs/development.md).

## Layout

```
src/lib/        command runner, outbox, connectivity, scan, problem, log   (no React)
src/lib/gs1/    pure GS1 scan parser (SSCC, GTIN, GS1-128 AIs 00/01/02/10/17/37), no network
src/api/        fulfillment-execution client + operator-facing error text
src/app/        services context, layout, router link
src/components/ ScanInput, OfflineBanner, NoticeBar, LeaseCountdown
src/features/   station/ (register, check-in/out, claim), task/ (confirm, renew, complete)
src/pwa/        service-worker registration
public/         manifest, icons, sw.js (hand-written)
build/          Vite plugin that stamps the precache list
scripts/        stub API, browser flow, docs gate
docs/           architecture, offline + idempotency, station flow, API contract, development
```

## Not here yet

Pack / SLAM / seal-package / rebin, stow / cycle-count / transfer-receipt, and the workforce-management shift clock are later PRs.
