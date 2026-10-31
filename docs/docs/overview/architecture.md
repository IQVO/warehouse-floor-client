# Architecture

```
Screen (React)
   |  asks for an action                     src/features/**
   v
StationProvider                              applies outcomes to persisted station state
   |
   v
fulfillmentApi(runner)                       src/api/fulfillmentExecution.ts: builds CommandSpecs
   |
   v
CommandRunner  <---- Outbox (localStorage)   src/lib/commands.ts, src/lib/outbox.ts
   |                  Connectivity           src/lib/connectivity.ts
   v
fetch("/api/<context>/...")  ---->  Kong  ---->  owning context
```

- **One network path.** Same-origin `/api/<context>/...` through Kong. No service URLs, no BFF, no auth. In dev Vite proxies `/api`; in the cluster the edge routes `/api` to Kong.
- **The runner owns commands.** Screens never call `fetch` for a `POST`/`PUT`. The runner mints the Idempotency-Key, persists the command, sends it, classifies the answer (done / problem / queued / unsent), and replays what is pending.
- **State survives reloads.** The station session (`wfc.station.v1`) and the outbox (`wfc.outbox.v1`) are in localStorage. The lease deadline is stored in the local clock, so a reload keeps the countdown.
- **Applying outcomes in one place.** `StationProvider.apply` handles an answer whether it arrived directly or from an outbox replay minutes later.
- **UI kit.** Layout is `@warehouse/ui-kit`'s `AppShell` and `Card`/`StatusPill`, with the kit's design tokens (`--wh-*`); `src/styles/floor.css` only adds touch-target sizing and the floor-specific banners.

- **Reads are not commands.** The receiving screens `GET` receipts and label data with `getJson` (`src/api/inboundReceiving.ts`) through `Services.fetchFn`; only writes go through the runner and outbox. Receiving has its own client (`inboundReceivingApi`) and its own notices; it does not use `StationProvider`.

## Runtime dependencies

`react`, `react-dom`, `react-router-dom`, `@warehouse/ui-kit`: the same four as warehouse-console. The service worker is hand-written (see the README for why).

## Not in the box

Auth (the fleet is unauthenticated by decision), a BFF, runtime config, Module Federation (this is a standalone app, not a console remote).
