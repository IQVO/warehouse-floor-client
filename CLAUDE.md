# Project: Warehouse Floor Client (a client, not a bounded context)

harness-template: v4

The first-party, scan-first PWA that operators use on RF guns and station
screens to run the warehouse floor. Three slices ship today: **stations** on
`fulfillment-execution` (register, check in/out, claim the next task, scan to
confirm, keep the lease alive, complete, break case), **receiving** on
`inbound-receiving` (scan cartons, cases and items against a receipt, close it)
and the **yard** on `yard-management` (gate check-in/reject/check-out, hostler
moves, dock door work). React 19 + Vite static files behind nginx; no binary,
no backend of its own.

It models no bounded context: no aggregates, no domain events, no persistence of
its own beyond a device-local outbox. Domain meaning belongs to the owning
context; this client renders what each API publishes and sends the commands each
API accepts.

## Strategic classification (read before writing code)

A **downstream Conformist** to each context's published OpenAPI (the owning
repo's OpenAPI spec, read from its `origin/develop`). It does not reinterpret
task types, states or error codes, and it never invents a field the spec does
not define. A new screen starts from the spec, not from a guess. REST guideline
adoption as a consumer: `docs/docs/adr/0001-adopt-fleet-rest-api-guideline.md`.

## Rules (NON-NEGOTIABLE)

- **Kong only.** Every call goes to same-origin `/api/<context>/...`
  (`fulfillment-execution`, `inbound-receiving`, `yard-management`; one module
  each in `src/api/`). No direct service URLs, no BFF for commands, no shared
  database, ever. One context's screen calls only that context's API; a flow
  that needs two contexts makes two explicit calls and shows each result.
- **Every command carries an `Idempotency-Key`.** Scanners and flaky Wi-Fi retry,
  so the key is generated ONCE per user action and reused on every retry of that
  action, including after a reload (pending commands are persisted; their
  outbox paths are migrated by `src/lib/outboxMigration.ts`, STANDARD 5.5).
  Never mint a fresh key inside a retry loop. Detail:
  `.claude/rules/offline-outbox-and-idempotency.md`.
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

## Commands

```bash
make install      # npm ci (needs ../warehouse-ui-kit built first, see README.md)
make check-fast   # oxlint + tsc --noEmit: the agent Stop-hook gate, run before "done"
make check        # lint typecheck test build docs (mirrors ci.yml); check-all = check
make dev          # vite on :5174 proxying /api to Kong; FLOOR_API_TARGET=... overrides
make stub-api     # in-memory fulfillment-execution stand-in on :8787
make e2e          # headless Chromium station, receiving and yard flows against E2E_BASE
make guide-lint   # these guides: skills load, references resolve, context budget
make harness-test # unit-test the agent hooks
```

Drive a changed flow in a real browser too: scanner focus, the service worker
and the offline outbox fail in ways unit tests do not show.

## Definition of done

- Lint, typecheck, test and build are green, as in CI.
- A new screen has a component test for its happy path and its problem+JSON path.
- A new command has a test that proves the `Idempotency-Key` is reused across a
  retry and across a reload.
- `README.md` stays accurate.

## Where things are written down

- `docs/docs/overview/`: architecture, the station, receiving and yard flows,
  offline and idempotency. `docs/docs/ecosystem/`: API contract and integration.
  `docs/docs/operations/`: configuration, runbook, troubleshooting.
  `docs/docs/development/testing.md`. ADRs: `docs/docs/adr/`.
- `.claude/rules/fleet/readme-standard.md`: fleet README standard (template copy).
- `.claude/skills/run-floor-client-locally/`: drive a change in a real browser
  (ui-kit sibling, stub, dev server, headless flows).
- `HARNESS.md`: every sensor and hook this repo runs, and when.
  `INCIDENTS.md`: the fleet incident log.

<!-- harness:scoped-rules:start (generated by tools/migrate_v3.py in warehouse-harness-template; do not hand-edit) -->
## Scoped rules and harness

Claude Code loads each rule below automatically when you touch the matching paths. OpenCode and Codex do NOT: read the rule BEFORE editing matching files.

| When touching | Read |
|---|---|
| `src/lib/**`, `src/pwa/**`, `src/api/**` ... | `.claude/rules/offline-outbox-and-idempotency.md` |

Hooks (`scripts/harness/hook.py`, wired for Claude Code, Codex and OpenCode) block pushes to develop/main, `--no-verify`, bare `rm -rf`, and edits to generated files, and feed gofmt/vet findings back after each edit. Before saying "done" run `make check-fast`; the full gate is `make check-all`. `HARNESS_OFF=1` disables the hooks when debugging the harness itself.
<!-- harness:scoped-rules:end -->
