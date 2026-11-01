---
id: configuration
title: Configuration
sidebar_label: Configuration
---

# Configuration

The floor client is a static bundle served by nginx, and it is deliberately
**configuration-free at runtime**: there is no `/config.json`, no `VITE_*`
build variable and no per-environment image. The only contract with the rest of
the platform is a relative path, `/api/<context>/...`, resolved against the
origin that served the page. "Configuration" is therefore spread over five
small places, each read at a different time:

| Where | Read when | Controls |
|---|---|---|
| `FLOOR_API_TARGET` (`vite.config.ts`) | when `vite` / `vite preview` starts | where the dev server proxies `/api` |
| `STUB_PORT`, `STUB_LEASE_MS` (`scripts/stub-api.mjs`) | when the stub API starts | stub port and lease length |
| `E2E_*`, `STUB_URL` (`scripts/e2e-*.mjs`) | when a browser flow runs | which origin the flow drives |
| `nginx.conf` | by the container's nginx | listen port, `/healthz`, `/api/` guard, cache headers, SPA fallback |
| constants in `src/` | compiled in | request timeout, replay interval, lease renewal, storage keys |

## Environment variables

### Build-time (`VITE_*`)

There are **none**. The code reads no `VITE_*` key and no custom
`import.meta.env` value, so the same image runs against any environment. The
only `import.meta.env` read is the Vite built-in `PROD`:

| Key | Read in | Effect |
|---|---|---|
| `import.meta.env.PROD` | `src/pwa/register.ts` | `true` in a `vite build` bundle: the service worker is registered. In `vite dev` it is not, because a worker would pin stale modules |

### Dev server and preview (`vite.config.ts`)

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `FLOOR_API_TARGET` | `http://localhost:8000` | no | Target of the `/api` proxy (`changeOrigin: true`) for both `npm run dev` and `npm run preview`. The default is Kong's host port in the kind cluster; the web gateway on `:80` serves HTML only and has no `/api` route. Point it at the stub (`http://localhost:8787`) to work without a cluster |

`server.port` and `preview.port` are fixed at `5174` with `strictPort: true`:
if the port is taken, Vite exits instead of picking another one.

### Stub API (`scripts/stub-api.mjs`)

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `STUB_PORT` | `8787` | no | Port of the in-memory stand-in for fulfillment-execution and inbound-receiving |
| `STUB_LEASE_MS` | `300000` | no | Lease the stub grants on `claim-next`. Use `20000` to see an automatic renewal within seconds |

### Browser flows (`scripts/e2e-station-flow.mjs`, `scripts/e2e-receiving-flow.mjs`)

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `E2E_BASE` | `http://localhost:5174` | no | Page origin the headless Chromium opens |
| `STUB_URL` | `http://localhost:8787` | no | Stub control origin (`/__stub/*` endpoints) |
| `E2E_SHOTS` | `e2e-shots` | no | Directory for screenshots |
| `E2E_CHROMIUM` | unset | no | Path of an installed Chromium; skips `npx playwright install` |
| `E2E_MODE` | `stub` | no | Station flow only. `real` runs against a dev server proxying to Kong and never completes real work |

These are test knobs, not application configuration.

## Compiled-in constants

Changing one needs a rebuild. They are listed because they decide how the app
behaves when the network or the service misbehaves.

| Constant | Value | Defined in | Effect |
|---|---|---|---|
| request timeout | 15 s | `requestTimeoutMs` in `src/lib/commands.ts` | a command that gets no answer is aborted and treated as "unreachable" (kept for replay) |
| replay interval | 5 s | `retryIntervalMs` in `src/lib/commands.ts` | while the outbox is non-empty the runner retries this often; also on the browser's `online` event and at page load |
| retryable statuses | `429`, `502`, `503`, `504` | `RETRYABLE_STATUS` in `src/lib/commands.ts` | kept in the outbox with the same key; every other answer is final |
| default lease | 5 min | `DEFAULT_LEASE_MS` in `src/features/station/stationState.ts` | used when a claim response gives no usable `leaseExpiry` |
| accepted lease range | 10 s to 60 min | `MIN_LEASE_MS`, `MAX_LEASE_MS` | a computed lease outside this range falls back to the default |
| renew threshold | half-life | `RENEW_AT_FRACTION` (`0.5`) | `renew-lease` is called when no more than half the lease is left |
| renew retry spacing | 10 s | `RENEW_RETRY_MS` | a failing renewal is retried no more often than this |
| log line cap | 200 characters | `MAX_LEN` in `src/lib/log.ts` | longer values are truncated with `...` |
| open receipts page | `limit=50`, first page | `listOpenReceipts` in `src/api/inboundReceiving.ts` | the receiving list does not follow `nextCursor` |

## Browser storage

State that survives a reload lives in `localStorage` (via `defaultStore()` in
`src/lib/storage.ts`, which falls back to memory when `localStorage` throws).

| Key | Owner | Holds |
|---|---|---|
| `wfc.outbox.v1` | `src/lib/outbox.ts` | FIFO of commands with no definitive answer: `key` (the Idempotency-Key), `kind`, `method`, same-origin `path`, `body`, `dedupeId`, `meta`, `createdAt`, `attempts`. Entries whose `path` does not start with `/api/` are dropped on load |
| `wfc.station.v1` | `src/features/station/stationState.ts` | station, occupant id and the held task with its lease deadline (in the local clock) |
| `wfc.probe` | `src/lib/storage.ts` | written and removed once to test that `localStorage` works |

Clearing site data deletes the outbox: commands that were not yet delivered are
lost. See [Troubleshooting](./troubleshooting.md).

## Nginx (`nginx.conf`)

The runtime image is `nginxinc/nginx-unprivileged` and listens on **8080**
(`EXPOSE 8080` in the `Dockerfile`). It serves the shell and **never proxies an
API**; Kong must answer `/api/<context>` at the same origin.

| Location | Behaviour | `Cache-Control` |
|---|---|---|
| `= /healthz` | `200 ok` (`text/plain`), access log off | none |
| `/api/` | `404` `application/problem+json` with title "No API at this address", so a mis-routed edge is obvious and never an SPA-fallback `200` | `no-store` |
| `= /sw.js` | the service worker, `404` if absent | `no-cache` |
| `= /manifest.webmanifest` | the PWA manifest, `404` if absent | `no-cache` |
| `= /index.html` | entry document | `no-cache` |
| `/assets/` | content-hashed bundle files, `404` if absent | `public, max-age=31536000, immutable` |
| `/` | `try_files $uri $uri/ /index.html`: React Router paths (`/task`, `/receiving/:receiptId`) load the shell | none |

`sw.js`, `index.html` and the manifest are `no-cache` on purpose: a redeploy
must not stay pinned behind an old app shell.

## Image build

`docker build --build-context uikit=../warehouse-ui-kit -t warehouse-floor-client .`
(`make image`). The build takes the sibling `warehouse-ui-kit` checkout as a
named build context. Stages: ui-kit build, app build (`npm install --no-save`,
the macOS-generated lockfile is discarded inside the layer), nginx runtime.
There is no Helm chart in this repo; see the [Runbook](./runbook.md) for what
that means for deployment.
