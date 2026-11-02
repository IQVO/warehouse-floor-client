---
id: offline-and-idempotency
title: Offline and idempotency
sidebar_label: Offline and idempotency
---

# Offline and idempotency

## The key rule

Every command (`POST`/`PUT`) sends an `Idempotency-Key` header. A key names **one operator action**.

| Situation | Key |
|---|---|
| First submit of an action | new (UUID v4) |
| Automatic replay after a network failure / 502 / 503 / 504 / 429 | **same** |
| Replay after reconnect | **same** |
| Replay after a page reload | **same** (read back from the outbox) |
| Operator taps the same button again while the action is still pending, body unchanged | **same** |
| Same action, body changed (e.g. a different quantity) | new (the service rejects a key reused with a different body) |
| Same action again after it has a definitive answer | new |
| Lease renewal (one per timer tick) | new per tick; never replayed |

Order of events for a command, in `CommandRunner.submit`:

1. build the outbox entry (`key`, `kind`, `method`, `path`, `body`, `dedupeId`, `meta`),
2. **write it to storage**,
3. send it (skipped when the browser reports no network),
4. on any HTTP answer other than 429/502/503/504, remove it and report the answer; otherwise leave it for replay.

`crypto.randomUUID` only exists in secure contexts, so keys fall back to `getRandomValues` (an RF gun on plain `http://<lan-host>` is not a secure context).

## Definitive vs retryable

- **Definitive** (entry removed, reported to the operator): every 2xx, every 4xx, and 500 with a problem body. Retrying a `409` or `422` cannot change the answer.
- **Retryable** (entry kept, same key): network failure, timeout (15 s), `429`, `502`, `503`, `504`.

## The outbox

`wfc.outbox.v1` in localStorage: FIFO, validated on load (a corrupt entry, or one whose path is not a same-origin `/api/...` path, is dropped). Replays run: at page load, on the browser's `online` event, every 5 s while anything is pending, and on "Retry now". A replay stops at the first command that still cannot be delivered, so order is preserved. A new command submitted behind older pending ones first tries to drain them.

What is queued (`kind`): `register`, `check-in`, `check-out`, `claim-next`, `pick-scan`, `complete`, `break-case`, `receive-scan`, `close-receipt`. Not queued: `renew-lease` (`persist: false`; the route is `POST .../lease-renewals`). Reads (`GET`) are plain fetches, never queued.

## Replays after a lost answer

Since the fleet REST guideline cutover (ADR 0001), fulfillment-execution and inbound-receiving key **every** `POST` and `PATCH`: the same key and body returns the stored answer with `Idempotency-Replayed: true`, a missing key is `400 idempotency-key-required`, a malformed one `400 idempotency-key-invalid`, and the same key with another request `409 idempotency-key-reused` (a client bug, not retried). So a command whose answer was lost is applied once when the outbox replays it with its original key. This is read from the specs; it has not been exercised against a live deployment from this repo.

Defence in depth stays in the client, because the stub and older deployments may not dedupe:

- **complete** (`POST .../completions`): a replay that was not deduplicated gets `409 task-already-completed`; the client treats that as success ("This task was already completed").
- **claim-next** (`POST .../task-claims`): a replay that was not deduplicated can lease a second task. The client keeps the task in hand and tells the operator to ignore the extra one; its lease returns it to the pool by itself.
- **check-in** (`POST .../check-ins`): a replay that was not deduplicated can get `409 station-occupied`, shown as is.

## Queued commands survive the route renames

A command queued by an older build holds the old path (for example `.../tasks/t-1/complete`), which now answers 404. `Outbox` rewrites such a path when it reads the store (`src/lib/outboxMigration.ts`): `claim-next` to `task-claims`, `check-in`/`check-out` to `check-ins`/`check-outs`, `complete` to `completions`, `break-case` to `case-breaks`, `renew-lease` to `lease-renewals`, `seal-package` to `package-seals`, `/packages/{id}/slam` to `slam-runs`, the receipt `close` to `closures`, and the appointment and ASN `check-in`/`cancel` to `check-ins`/`cancellations`. The entry keeps its `Idempotency-Key`, `dedupeId`, body and queue position, the rewritten store is saved back, and a path that is already new or not recognised is left alone (a queued write is never dropped by the migration).

## Offline banner

`OfflineBanner` is always mounted (in `Layout`) and renders nothing while the network is believed to work and nothing is pending. It shows while the browser reports offline **or** the last request never reached the edge (Wi-Fi with no route), and stays visible, as "Sending saved actions", while saved commands are pending, with a "Retry now" button and a count.

## Service worker

`public/sw.js`, hand-written. It precaches the app shell only (the file list is stamped at build time by `build/precacheManifest.ts`).

| Request | Handling |
|---|---|
| non-GET (every command) | not intercepted |
| anything under `/api/` | not intercepted: never stored, never served from cache |
| cross-origin | not intercepted |
| GET of a precached shell file | cache first |
| navigation | network first, cached `index.html` when offline |

Cache names are versioned by a content hash of the shell; old ones are deleted on activate. `nginx.conf` serves `sw.js`, `index.html` and the manifest with `no-cache`.

Tests: `src/pwa/sw.test.ts` (loads `public/sw.js` into a sandbox and asserts the table above), `src/lib/lib.test.ts` (key reuse, persistence, replay order), and the offline cases in `src/features/**/*.test.tsx` and `scripts/e2e-station-flow.mjs`.

## inbound-receiving (receiving dock)

inbound-receiving's `POST /receipts/{id}/scans` requires the key and replays the stored answer for a repeated key (and `409 idempotency-key-reused` for a changed body), per its OpenAPI. Each physical scan is its own action (own key); a saved or lost-answer scan is replayed with its key, also after a reload. See [Receiving flow](/docs/overview/receiving-flow).
