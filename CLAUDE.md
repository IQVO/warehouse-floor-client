# Project: Warehouse Floor Client (a client, not a bounded context)

The first-party, scan-first PWA that operators use on RF guns and station
screens to run the warehouse floor: claim and complete tasks, pack and slam,
stow and cycle-count, and clock a shift. It is the production caller of the
floor-execution REST APIs of `fulfillment-execution`, `inventory-storage` and
`workforce-management`, which until this repo had only `e2e-tests` driving them.

It models no bounded context: no aggregates, no domain events, no persistence of
its own beyond a device-local outbox. Domain meaning belongs to the owning
context; this client renders what each API publishes and sends the commands each
API accepts.

## Strategic classification (read before writing code)

A **downstream Conformist** to each context's published OpenAPI
(`apis/openapi.yaml` in the owning repo, read from `origin/develop`). It does not
reinterpret task types, states or error codes, and it never invents a field the
spec does not define. A new screen starts from the spec, not from a guess.

## Rules (NON-NEGOTIABLE)

- **Kong only.** Every call goes to same-origin `/api/<context>/...`
  (`fulfillment-execution`, `inventory-storage`, `workforce-management`). No
  direct service URLs, no BFF for commands, no shared database, ever. One
  context's screen calls only that context's API; a flow that needs two contexts
  makes two explicit calls and shows each result.
- **Every command carries an `Idempotency-Key`.** Scanners and flaky Wi-Fi retry,
  so the key is generated ONCE per user action and reused on every retry of that
  action, including after a reload (pending commands are persisted). Never mint a
  fresh key inside a retry loop.
- **Offline is read-only for the shell, queued for commands.** The service worker
  precaches the app shell only; API responses are never served from cache. When
  offline the operator sees a clear banner, and commands wait in the persisted
  outbox and replay with their original keys. Never show a queued command as
  done.
- **Scan first.** The primary input is a focus-locked field that captures
  keyboard-wedge scanner input ended by Enter, with a manual-entry fallback and
  large touch targets. A screen must work with a scanner and no pointer.
- **Say what happened, in plain words.** Problem+JSON errors become "what
  happened and what to do next" for an operator standing at a rack, never raw
  JSON, never a status code alone. A missing reading is "—", never a calm zero.
- **No authentication in this client.** The fleet is unauthenticated by decision
  (reverted 2026-09-11); do not add a login, tokens or headers for it without the
  owner re-adopting auth.
- Use `@warehouse/ui-kit` (`file:../warehouse-ui-kit`, a sibling checkout) for
  every design-token and component need; never hand-roll what the kit provides.
- Log nothing request-derived without stripping CR/LF.

## Not in scope

Supervisor and planner screens live in `warehouse-console` and each context's own
remote. Do not add them here. The floor client is for the person holding the
scanner.

## Tech and commands

React 19, TypeScript (strict), Vite, oxlint and vitest, packaged like
`warehouse-console` (`Dockerfile`, `nginx.conf`). The Makefile and `README.md`
are the source of truth for commands and ports; run the repo's check target and
`npm test` before saying "done", and drive a changed flow in a real browser, since
scanner focus, the service worker and the offline outbox fail in ways unit tests
do not show.

## Definition of done

- Lint, typecheck, test and build are green, as in CI.
- A new screen has a component test for its happy path and its problem+JSON path.
- A new command has a test that proves the `Idempotency-Key` is reused across a
  retry and across a reload.
- `README.md` stays accurate.
