---
paths:
  - "src/lib/**"
  - "src/pwa/**"
  - "src/api/**"
  - "src/components/OfflineBanner.tsx"
  - "src/components/StuckOutboxBanner.tsx"
  - "public/sw.js"
  - "build/**"
  - "nginx.conf"
---

# Offline outbox, Idempotency-Key and the service worker

Full reasoning and the event-by-event table: `docs/docs/overview/offline-and-idempotency.md`.

## The key names one operator action

- `newIdempotencyKey()` (`src/lib/idempotency.ts`) is called ONCE per action, when it is first
  submitted. The entry (key, kind, method, path, body, dedupeId, meta) is written to the outbox
  BEFORE the request is sent (`CommandRunner.submit` in `src/lib/commands.ts`).
- Every replay (network failure, timeout, 429/500/502/503/504, reconnect, page reload, the operator
  tapping again with the same body) reuses the stored key. A changed body or a new action after a
  definitive answer gets a new key. Lease renewals are not persisted and get a new key per tick.
- Never mint a key inside a retry loop, and never drop a queued entry to "fix" a stuck queue: the
  attempt cap (`maxAttempts`, default 8) marks it `stuck` and `StuckOutboxBanner` lets the operator
  send it again (same key) or discard it.
- Definitive answers (every 2xx and 4xx) remove the entry; only the `RETRYABLE_STATUS` set and
  network failures keep it. Do not add 409/422 to the retryable set.

## Outbox store and path migrations

- `localStorage` key `wfc.outbox.v1`, FIFO, validated on load (non same-origin `/api/...` paths are
  dropped). A replay stops at the first undeliverable entry so order is preserved.
- A command queued by an older build holds the old path: `src/lib/outboxMigration.ts` rewrites it on
  read, keeping key, dedupeId, body and position. When a context renames a route, add the rewrite
  there with a test in `src/lib/outboxMigration.test.ts`; a queued write is never dropped.

## Service worker

- `public/sw.js` is hand-written and precaches the app shell only (list stamped by
  `build/precacheManifest.ts`). It never intercepts non-GET, `/api/`, or cross-origin requests:
  API answers are never cached or served offline. `src/pwa/sw.test.ts` asserts that table.
- `nginx.conf` serves `sw.js`, `index.html` and the manifest with `no-cache`.

## API modules

- One module per context in `src/api/` (`fulfillmentExecution.ts`, `inboundReceiving.ts`,
  `yardManagement.ts`), each with a same-origin `/api/<context>` base that Kong routes. Shapes come
  from that context's published OpenAPI on its `develop` branch; never invent a field.
- Problem+JSON becomes operator words in the matching `*Messages.ts`; never show raw JSON or a bare
  status code.
