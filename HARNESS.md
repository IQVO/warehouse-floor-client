# HARNESS.md — warehouse-floor-client

What agent harness this repo has, what each piece runs, and when. Model (from
`warehouse-harness-template`, after Böckeler, "Harness engineering for coding agent users"):
**guides** steer an agent before it acts (feedforward), **sensors** report after it acts (feedback);
each is **computational** (deterministic) or **inferential** (LLM). This is the scan-first PWA for the
floor, not a Go bounded context: there is no coverage gate, arch-test, bdd, mutation, api-lint,
docs-api-drift, helm chart or image scan here. Only what is listed below exists.

harness-template: v4

## Guides (feedforward)

| File | Type | Purpose |
|---|---|---|
| `CLAUDE.md` (`AGENTS.md` is a symlink to it) | computational | Entry point: the three slices, Conformist stance, non-negotiable rules, commands, definition of done. |
| `.claude/rules/offline-outbox-and-idempotency.md` | computational | Scoped to `src/lib/**`, `src/pwa/**`, `src/api/**`, the banners, `public/sw.js`, `build/**`, `nginx.conf`: one key per action, the outbox, path migrations, the service worker. |
| `.claude/rules/fleet/readme-standard.md` | computational | Fleet README standard (copied from the template). |
| `.claude/skills/run-floor-client-locally/SKILL.md` | inferential | Run and drive a flow in a real browser against the stub or Kong. |
| `.claude/agents/*.md` | inferential | `code-review`, `architecture-review`, `domain-review` subagents (template-managed). |
| `.claude/memory/MEMORY.md` | computational | Durable repo heuristics that are not incidents. |
| `docs/docs/` | computational | Docusaurus site: flows, offline and idempotency, operations, ADRs. |
| `INCIDENTS.md` | computational | Fleet incident log: every escape with its fix and the sensor that now guards it. |

## Sensors (feedback)

All jobs below are in `.github/workflows/ci.yml` (PR and push to develop/main) unless named otherwise.
`lint`, `test`, `typecheck` and `build` check out `warehouse-ui-kit` beside this repo and build it first.

| Sensor | What it runs | Blocking? |
|---|---|---|
| `lint` | `npm run lint` (oxlint) | yes |
| `file-length` | oxlint with `.oxlintrc.file-length.json` on the TypeScript files a PR into develop touches (plus a self-test); full-tree backlog report otherwise | yes (backlog report is informational) |
| `guide-lint` | `guide_lint.py` (skills load, cited paths and `make` targets exist, context budget), `repo_lint.py` (workflow paths, `needs:`, Dependabot, stale owner, placeholders), `test_hook.py`, `test_red_issue.py`, `test_repo_lint.py` | yes |
| `test` | `npm test` (vitest with coverage, jsdom + Testing Library; includes `src/pwa/sw.test.ts`) | yes |
| `typecheck` | `npm run typecheck` (`tsc -b --noEmit`) | yes |
| `build` | `npm run build` (`tsc -b && vite build`, stamps the precache list) | yes |
| `docs` | Docusaurus site under `docs/`: typecheck + build | yes |
| Docs site build/deploy | `.github/workflows/docs.yml` | PRs touching `docs/**`; deploy on main |
| CodeQL | `.github/workflows/codeql.yml` | yes |
| AI review | `.github/workflows/ai-review.yml` (needs `ANTHROPIC_API_KEY`; path filter `internal/domain`, `apis`, `charts`, none of which exist here, so it does not fire) | no (advisory) |
| Browser flows | `make e2e` (station, receiving, yard in headless Chromium) | local only, by hand |

Local gates: `make check-fast` (lint + typecheck; the agent Stop hook runs it), `make check` /
`make check-all` (lint, typecheck, test, build, docs), `make guide-lint`, `make harness-test`.

## Agent runtime harness

| Piece | Files | Lifecycle |
|---|---|---|
| Guard + feedback hooks | `scripts/harness/hook.py` (`pre` / `post` / `stop`) with adapters `.claude/settings.json`, `.codex/hooks.json`, `.opencode/plugins/harness.ts` | every tool call; end of turn |
| Skills for Codex | `.agents/skills` symlink to `.claude/skills` | on task match |
| Red-sensor helper | `scripts/harness/red_issue.py` (tested; no scheduled job here calls it yet) | n/a |

The hooks block pushes to develop/main, `--no-verify`, force-push, bare `rm -rf` on non-scratch
paths, destructive git, and edits to generated files; the Stop hook runs `make check-fast` when code
changed. `HARNESS_OFF=1` disables them. The `scripts/harness/*.py` files and the three adapters are
template-managed copies: change them in `warehouse-harness-template`, never here.

## Incident protocol

Every failure that was not caught before CI ends with the fix, a sensor or guide that would have
caught it, that sensor rolled out fleet-wide, and a row in [INCIDENTS.md](INCIDENTS.md). A row with
no guard is an open gap and says so.
