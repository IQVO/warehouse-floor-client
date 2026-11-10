---
name: run-floor-client-locally
description: Run and prove a floor-client change in a real browser (ui-kit sibling build, dev server, in-memory stub, headless station/receiving/yard flows). Use when a change touches a screen, the outbox, scanning or the service worker and unit tests alone cannot show it works.
---

# Run the floor client locally and drive a flow

Unit tests miss scanner focus, the service worker and the offline outbox. Before saying a flow
works, drive it.

## 1. Sibling ui-kit, then install

`@warehouse/ui-kit` is `file:../warehouse-ui-kit`, so the kit must be checked out beside this repo
and built first (see `README.md`):

```bash
(cd ../warehouse-ui-kit && npm ci && npm run build)
make install
```

## 2. Gates

```bash
make check-fast   # oxlint + typecheck (the Stop-hook gate)
make check        # lint typecheck test build docs: what CI runs
```

## 3. Dev server against the stub (no cluster needed)

```bash
make stub-api                                   # :8787, in-memory fulfillment-execution,
                                                # inbound-receiving, yard-management (site WH1)
FLOOR_API_TARGET=http://localhost:8787 make dev # :5174
make e2e                                        # station, receiving and yard flows, headless Chromium
```

`STUB_LEASE_MS` shortens the stub's task lease when you need to watch a renewal or expiry.

## 4. Against the cluster

`make dev` alone proxies `/api` to Kong at `http://localhost:8000`. Never point
`FLOOR_API_TARGET` at the web gateway on `:80`: it answers HTML 200 for any path, so a probe there
looks green while no API is reached.

## 5. What to check by hand

- Scan with the keyboard only (type, then Enter) into the focus-locked field; the manual-entry
  fallback works.
- Go offline in devtools: the offline banner shows, a command is queued (never shown as done), and
  it replays with the same `Idempotency-Key` on reconnect and after a reload.
- Service workers only run on `https` or `http://localhost`.
