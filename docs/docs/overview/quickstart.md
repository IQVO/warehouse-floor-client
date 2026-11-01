---
id: quickstart
title: Quickstart
sidebar_label: Quickstart
---

# Quickstart

Run the floor client locally, with the bundled stub API (no cluster) or with
Kong in the kind cluster, and know the commands the project uses every day.

:::note No captured run
The commands below are taken from `package.json`, the `Makefile` and
`scripts/stub-api.mjs`. This page shows no sample output: nothing here was
captured from a live run.
:::

## Prerequisites

| Need | Why |
|---|---|
| Node.js 22 (CI uses 22 for the app, 20 for `docs/`) and npm | build, test, dev server |
| a sibling checkout `../warehouse-ui-kit`, built once | `@warehouse/ui-kit` is a `file:../warehouse-ui-kit` dependency |
| Docker with BuildKit (optional) | `make image` |
| Chromium via Playwright (optional) | `npm run e2e:*`; `npx playwright install chromium`, or `E2E_CHROMIUM=/path/to/chrome` |
| the kind cluster with Kong on `http://localhost:8000` (optional) | to work against the real services |

There is no database, no Kafka and no Postgres here: the client is a static
front end. The services it talks to own all of that.

## Setup

```bash
cd ..                                   # the directory that holds warehouse-ui-kit
(cd warehouse-ui-kit && npm ci && npm run build)
cd warehouse-floor-client
npm ci
```

## Everyday commands

| Command | What |
|---|---|
| `npm run dev` | dev server on `:5174`; `/api` is proxied to `FLOOR_API_TARGET` (default `http://localhost:8000`, Kong) |
| `npm run lint` | oxlint |
| `npm run typecheck` | `tsc -b --noEmit` (app, node and test projects; `strict` + `noUncheckedIndexedAccess`) |
| `npm test` | vitest, jsdom |
| `npm run build` | `tsc -b && vite build`, then stamps the precache list into `dist/sw.js` |
| `npm run preview` | serves `dist/` on `:5174` with the same `/api` proxy (the service worker is registered here, not in `dev`) |
| `npm run stub-api` | in-memory fulfillment-execution and inbound-receiving on `:8787` |
| `npm run e2e:station`, `npm run e2e:receiving` | headless Chromium flows against the dev server and the stub |
| `make docs` | this site: in `docs/`, `npm ci`, `npm run typecheck`, `npm run build` |
| `make check` | `lint typecheck test build docs`: what CI runs |
| `make image` | `docker build --build-context uikit=../warehouse-ui-kit -t warehouse-floor-client .` |

All `make` targets: `help install lint typecheck test build docs check
check-all check-fast dev stub-api e2e image`. The testing layers are described
in [Testing](/docs/development/testing).

## Run it with no cluster (stub)

```bash
STUB_LEASE_MS=20000 npm run stub-api &                    # http://localhost:8787
FLOOR_API_TARGET=http://localhost:8787 npm run dev &      # http://localhost:5174
```

Open `http://localhost:5174`. The stub is seeded with two PICK tasks
(`order-42`, `order-43`) and one open receipt `rcpt-stub-1` (ASN-1001, two
lines). In the browser:

1. **Station** (`/`): station ID `S1`, capabilities `pick`, Register; then type
   a badge ID in the scan field and press Enter to check in; press **Pick**.
2. **Task** (`/task`): scan the order label shown on the task (`order-42`),
   then **Complete task**. With `STUB_LEASE_MS=20000` watch the countdown renew
   itself at half-life.
3. **Receiving** (`/receiving`): open `rcpt-stub-1`, choose **Carton**, scan
   `340123450000000017` (a 20-each homogeneous carton), then **Close receipt**.
   Other seeded scans: `340123450000000024` (mixed carton),
   `340123450000000031` (over the limit), case GTIN `13041090004824` (no
   carton label, `UnlabelledCarton`), each GTIN `03041090004827`.

Try the offline path: stop the stub, press Complete, restart the stub. The
banner appears, the command is saved ("Completion saved on this device") and
is replayed with its original key.

### Calling the stub directly

The stub enforces `Idempotency-Key` on every `POST` (stricter than the real
service). Replaying a call with the same key and body returns the stored
answer; the same key with another body is `422 idempotency-key-reused`.

```bash
curl -s -X POST http://localhost:8787/api/fulfillment-execution/stations \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"stationId":"S1","capabilities":["pick"]}'

curl -s -X POST http://localhost:8787/api/fulfillment-execution/stations/S1/check-in \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-2' \
  -d '{"occupantId":"badge-7"}'

curl -s -X POST http://localhost:8787/api/fulfillment-execution/stations/S1/claim-next \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-3' \
  -d '{"taskType":"PICK"}'

curl -s http://localhost:8787/__stub/log       # every command received, with its key
curl -s -X POST http://localhost:8787/__stub/reset
```

`POST /__stub/drop-next-response` applies the next command and cuts the
connection before answering, which proves the client reuses its key. The stub
implements stations, `claim-next`, `renew-lease`, `complete`, queue depth and
the receiving endpoints; it does not implement the pick-scan or `break-case`
endpoints.

## Run it against the cluster

```bash
npm run dev          # FLOOR_API_TARGET defaults to http://localhost:8000 (Kong)
E2E_MODE=real npm run e2e:station
```

In the kind cluster Kong listens on `:8000`; the web gateway on `:80` serves
HTML only and has no `/api` route, which is why the dev server proxies to Kong
and not to `:80`. `E2E_MODE=real` registers a throwaway station, checks in, and
claims only if the queue shows work; it never completes real work.

Browsers run service workers only on `https` or `http://localhost`. On plain
`http://<lan-host>` the app works without the offline app shell; the outbox
still works.

## Build the image

```bash
make image
docker run --rm -p 8080:8080 warehouse-floor-client
```

Same builder-stage approach as warehouse-console's image: a glibc node image,
the lockfile discarded inside the build layer, an `nginx-unprivileged` runtime
on `:8080`. See the [Runbook](/docs/operations/runbook) and
[Configuration](/docs/operations/configuration).

## Where next

- How the code is layered: [Architecture](./architecture.md)
- A task from register to complete: [Station flow](./station-flow.md)
- Something misbehaves: [Troubleshooting](/docs/operations/troubleshooting)
