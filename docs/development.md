# Development

## Setup

The ui-kit is a sibling directory (`file:../warehouse-ui-kit`); build it once:

```bash
(cd ../warehouse-ui-kit && npm ci && npm run build)
npm ci
```

## Everyday commands

| Command | |
|---|---|
| `npm run dev` | :5174; `/api` -> `FLOOR_API_TARGET` (default `http://localhost:8000`, Kong) |
| `npm run lint` | oxlint |
| `npm run typecheck` | `tsc -b --noEmit` (app, node and test projects; `strict` + `noUncheckedIndexedAccess`) |
| `npm test` | vitest, jsdom |
| `npm run build` | `tsc -b && vite build`, then stamps the precache list into `dist/sw.js` |
| `npm run docs:check` | structural check of `docs/` and `README.md` links |
| `make check` | all of the above |

## Testing approach

- **Fetch stub, not msw.** `src/test/fetchStub.ts` is a routed `fetch` stand-in; an unmatched request throws, so a new endpoint cannot sneak in unstubbed. Fixtures are shaped from the OpenAPI examples.
- **Per screen: a happy path and a problem+JSON path**, plus the offline/reload cases for commands.
- `src/test/renderApp.tsx` builds a fresh services set (store, outbox, runner) per test; reusing the store simulates a page reload.
- Lease tests use fake timers.
- The service worker is tested by evaluating `public/sw.js` in a sandbox with a fake worker scope.

## Stub API and browser flow

```bash
STUB_LEASE_MS=20000 npm run stub-api &                      # :8787
FLOOR_API_TARGET=http://localhost:8787 npm run dev &        # :5174
npm run e2e:station                                         # headless Chromium
npm run e2e:receiving                                       # receiving dock against the stub (carton, over-limit, unlabelled, lost answer)
E2E_MODE=real npm run e2e:station                           # against Kong (needs the cluster); never completes real work
```

`E2E_CHROMIUM=/path/to/chrome` reuses an installed Chromium instead of `npx playwright install`. The stub enforces `Idempotency-Key` on every POST and replays the stored answer for a repeated key (stricter than the real service, which does so on `POST /tasks` only), and can apply a command and then cut the connection (`POST /__stub/drop-next-response`) to prove the client reuses its key.

## CI

`.github/workflows/ci.yml`, like warehouse-console, checks out this repo and `IQVO/warehouse-ui-kit@develop` as siblings and builds the kit before `npm ci`.

| Job | Runs |
|---|---|
| `lint` | `npm run lint` |
| `test` | `npm test` |
| `typecheck` | `npm run typecheck` |
| `build` | `npm run build` |
| `docs` | `npm run docs:check` (no install, no ui-kit) |
| CodeQL | `javascript-typescript`, `security-extended`, weekly |

**Why `docs` differs from the console's.** The console's `docs` job builds a Docusaurus site (`npm ci`, typecheck, build in `docs/`). A site generator for five Markdown pages would be the heaviest dependency in this repo, so `docs/` is plain Markdown and the job is the lightest equivalent that still fails on what a docs build catches: a missing title, a broken relative link, a page absent from `docs/index.md`. If the docs grow into a site, replace the script and keep the job name.

The console's `trivy-fs-scan`, Helm and publish jobs are not replicated yet: there is no chart and no registry publish in this repo.

## Image

```bash
make image      # docker build --build-context uikit=../warehouse-ui-kit -t warehouse-floor-client .
```

Same builder-stage approach as the console's Dockerfile (glibc node image, lockfile discarded inside the build layer, nginx-unprivileged runtime on :8080).
