---
id: 0001-adopt-fleet-rest-api-guideline
title: "ADR 0001: Adopt the fleet REST API guideline"
sidebar_label: "0001 Fleet REST API guideline"
---

# ADR 0001: Adopt the fleet REST API guideline

- Status: accepted (2026-11-02)
- Scope: this client only. The standard itself is the fleet's REST API guideline (warehouse-docs).

## Context

The floor client is a downstream Conformist of the floor-execution REST APIs. The fleet moved
those APIs to one REST guideline as a hard cutover: command URLs are plural nouns (no verb
segments, no `:custom` suffix), every `POST`/`PATCH` carries an `Idempotency-Key`, reuse of a key
for a different request answers `409 idempotency-key-reused` (was `422`), a replay carries
`Idempotency-Replayed: true`, and every collection answers `{items, nextCursor}` with `limit` and
`cursor`. This client owns no API, so it adopts the guideline as a **consumer** (STANDARD section 5).

## Decision

1. **Routes.** The client calls the renamed routes (status codes and bodies are unchanged):

   | Was | Now |
   |---|---|
   | `POST /stations/{id}/claim-next` | `POST /stations/{id}/task-claims` |
   | `POST /stations/{id}/check-in` | `POST /stations/{id}/check-ins` |
   | `POST /stations/{id}/check-out` | `POST /stations/{id}/check-outs` |
   | `POST /tasks/{id}/renew-lease` | `POST /tasks/{id}/lease-renewals` |
   | `POST /tasks/{id}/complete` | `POST /tasks/{id}/completions` |
   | `POST /tasks/{id}/break-case` | `POST /tasks/{id}/case-breaks` |
   | `POST /receipts/{id}/close` (inbound-receiving) | `POST /receipts/{id}/closures` |

   The outbox `kind` values (`claim-next`, `complete`, ...) are client-internal names and do not change.
2. **Persisted outbox migration.** A queued entry written by an older build holds an old path that
   would answer 404 forever. `Outbox.read()` rewrites known legacy paths (all of the table above plus
   `seal-package`, `slam`, the sweep jobs, and the inbound-receiving appointment/ASN
   `check-in`/`cancel`) to the new ones, saves the result, and keeps `key`, `dedupeId`, `body`,
   `method` and queue position, so the replay still carries the original `Idempotency-Key`. Unknown
   paths are left untouched: the migration never drops a queued write. It is pure and idempotent
   (`src/lib/outboxMigration.ts`).
3. **Idempotency.** Unchanged in the client: one key per user action, persisted with the command,
   reused on every retry and after a reload. `409 idempotency-key-reused` and
   `400 idempotency-key-invalid` get plain-words messages (a client bug; "reload and try again").
4. **Lists.** The open-receipts list follows `nextCursor` (`cursor` query parameter) until absent,
   bounded at 20 pages of 50.
5. **Stub and e2e.** `scripts/stub-api.mjs` serves the new routes, answers `409` for key reuse,
   `400 idempotency-key-invalid` for a malformed key and adds `Idempotency-Replayed: true` on a replay.

## Exemptions

None. The client declares no API and no OpenAPI, so no Spectral ruleset or pagination exemption
applies here.

## Consequences

- Breaking: this build must be deployed together with the REST cutover set of the providers. An old
  client against new services (or the reverse) 404s on every command.
- Docs that described `422` for key reuse, or "the service keys `POST /tasks` only", are updated.
