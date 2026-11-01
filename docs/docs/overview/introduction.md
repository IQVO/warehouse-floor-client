---
id: introduction
title: Introduction
sidebar_label: Introduction
---

# Warehouse Floor Client

**warehouse-floor-client** is the scan-first progressive web app that
operators use on RF guns and station screens to run the warehouse floor. It is
the first-party client of the floor-execution REST APIs: it registers a
station, checks an operator in, claims the next task, keeps the lease alive,
takes the confirming scans, completes the task, and, at the receiving dock,
receives cartons against an inbound receipt.

It is a **client, not a bounded context**. It models no aggregate, raises no
domain event and persists nothing except a device-local outbox and the station
session. Domain meaning stays with the owning context; the app renders what
each API publishes and sends the commands each API accepts, as a downstream
**Conformist** to the published OpenAPI of that context.

| | |
|---|---|
| Area | Experience |
| Subdomain class | Experience (an application, not a domain subdomain) |
| Kind | React 19 + Vite 8 + TypeScript (strict) PWA, static files behind `nginx-unprivileged` on :8080 |
| UI kit | `@warehouse/ui-kit` (sibling checkout `file:../warehouse-ui-kit`) |
| Talks to | Kong at the page's own origin, `/api/<context>/...` |
| Authentication | none; the fleet is unauthenticated by decision |

## What it does

| Capability | Screen and route | Context it calls | Page |
|---|---|---|---|
| Register a station, check in by badge, pull work, check out | Station, `/` | fulfillment-execution | [Station flow](./station-flow.md) |
| Hold a task with a visible lease that renews itself | Task, `/task` (`LeaseCountdown`) | fulfillment-execution | [Station flow](./station-flow.md) |
| Confirm a pick by scanning each item or case, complete PICK, RELOCATE and REPLENISH, break a sealed case | Task, `/task` | fulfillment-execution | [Station flow](./station-flow.md) |
| Receive cartons, cases and items against a receipt, audit a mixed carton, close the receipt, print an unlabelled carton's label | Receiving, `/receiving` and `/receiving/:receiptId` | inbound-receiving | [Receiving flow](./receiving-flow.md) |
| Keep working when the network drops: banner, persisted outbox, replay with the original key | every screen | n/a | [Offline and idempotency](./offline-and-idempotency.md) |
| Load the app shell with no network | service worker (`public/sw.js`) | n/a | [Offline and idempotency](./offline-and-idempotency.md) |

The three feature folders are `src/features/station`, `src/features/task` and
`src/features/receiving`; shared pieces are `ScanInput`, `OfflineBanner`,
`NoticeBar`, `LeaseCountdown` and `Barcode128` under `src/components`.

## What it owns, and what it does not

**Owns**

- Everything the operator sees and touches: screens, scan capture, touch
  targets, plain-words error text for every problem code.
- The device-side mechanics of reliable commands: the Idempotency-Key per
  action, the persisted outbox (`wfc.outbox.v1`), replay in order, connectivity
  detection.
- The station session on the device (`wfc.station.v1`) and the local lease
  countdown.
- GS1 parsing and Code 128 / GS1-128 label drawing in the browser.
- The app shell: manifest, hand-written service worker and the nginx image.

**Does not own**

- Tasks, stations, leases and pick plans (fulfillment-execution); receipts,
  cartons, discrepancies and quantities (inbound-receiving). The device
  computes no quantity: it shows what the service says.
- Any API, event, database, authentication or BFF. Nothing calls this app.
- Supervisor and planner screens: those live in `warehouse-console` and each
  context's own remote.
- The edge that routes `/api` to Kong at its host, and any cluster deployment
  (no chart here; nothing in `warehouse-infra` yet).
- Pack, SLAM, put-wall, stow, cycle-count, transfer-receipt and the shift
  clock: later work.

## The rules it lives by

The repo has no ADRs; its decisions are the numbered rules in the README
("Rules this repo lives by"), reflected in the pages below:

1. **Kong only, same origin.** Relative `/api/<context>/...`, no service URLs.
2. **Every command carries an `Idempotency-Key`** minted once per action and
   reused on every retry, also after a reload.
3. **Offline: banner, persisted outbox, shell-only service worker.** No API
   response is ever served from cache.
4. **Scan first.** One focus-locked input for every barcode.
5. **Errors are for operators:** what happened and what to do, never raw JSON.
6. **Log through `src/lib/log.ts`**, which flattens CR/LF.
7. **GitFlow, and the CI names `lint`, `test`, `typecheck`, `build`, `docs`.**

## Where to go next

| I want to... | Read |
|---|---|
| see how the code is layered | [Architecture](./architecture.md) |
| run it, with or without a cluster | [Quickstart](./quickstart.md) |
| understand keys, the outbox and the service worker | [Offline and idempotency](./offline-and-idempotency.md) |
| follow a station through a task | [Station flow](./station-flow.md) |
| follow a receipt through the dock | [Receiving flow](./receiving-flow.md) |
| configure or deploy it | [Configuration](/docs/operations/configuration), [Runbook](/docs/operations/runbook) |
| debug it | [Troubleshooting](/docs/operations/troubleshooting) |
| run and extend the tests | [Testing](/docs/development/testing) |
| see what it calls and how it fails | [Integration](/docs/ecosystem/integration), [API contract](/docs/ecosystem/api-contract) |
