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

What is queued: register, check-in, check-out, claim-next, complete. Not queued: lease renewal.

## Known caveat: the service enforces keys on `POST /tasks` only

fulfillment-execution's `Idempotency-Key` middleware (ADR-0028) is attached to `POST /tasks`. The station and task endpoints this client uses ignore the header. So if a response is lost after the server applied the command, a replay is **not** de-duplicated by the server:

- **complete**: the replay gets `409 task-already-completed`. The client treats that as success ("This task was already completed").
- **claim-next**: a replay can lease a second task. The client keeps the task in hand and tells the operator to ignore the extra one; its lease returns it to the pool by itself (no loss, at-most-once holds).
- **check-in**: a replay can get `409 station-occupied`, shown as is.

Sending the key everywhere is still required: it is the contract, it costs nothing, and the day the service enforces it these replays become exact.

## Offline banner

`OfflineBanner` is always mounted. It shows while the browser reports offline **or** the last request never reached the edge (Wi-Fi with no route), and stays visible while saved commands are pending, with a "Retry now" button and a count.

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
