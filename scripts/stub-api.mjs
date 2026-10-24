#!/usr/bin/env node
// In-memory stand-in for fulfillment-execution's station/task endpoints, shaped
// from apis/openapi.yaml's examples. For local work and the browser flow check
// (scripts/e2e-station-flow.mjs) when no cluster is available.
//
//   npm run stub-api                       # :8787
//   FLOOR_API_TARGET=http://localhost:8787 npm run dev
//
// It is STRICTER than the real service on purpose: it enforces Idempotency-Key
// on every POST (the real one enforces it on POST /tasks only), replaying the
// stored answer for a repeated key and answering 422 idempotency-key-reused for
// a key sent with a different body. A client that passes against this stub
// therefore sends a key on every command and reuses it on retries.
//
// Test controls (not part of the real API):
//   POST /__stub/reset               clear all state, reseed tasks
//   POST /__stub/tasks               add a task (JSON: a TaskResponse-like object; optional hidden
//                                    `pick: {sku, plannedEaches, unit: "EACH"|"CASE"}` for scan-confirm,
//                                    `type: "BREAK_CASE"` for the case break)
//   POST /__stub/claim               lease task {taskId} to station {stationId} (BREAK_CASE is not claim-next-able)
//   POST /__stub/drop-next-response  apply the next command, then cut the connection before answering
//   GET  /__stub/log                 every command received (method, path, key, body, replayed)
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 8787);
const LEASE_MS = Number(process.env.STUB_LEASE_MS ?? 300_000);
const BASE = "/api/fulfillment-execution";
const ERR = "https://errors.fulfillment-execution.warehouse-systems.dev";

// A local PackView, as fulfillment-execution keeps from product-master: 14-digit GTIN -> pack level.
// Real GS1 codes (check digits valid): SKU-1 each EAN-13 3041090004827, its 12-pack case ITF-14 13041090004824; SKU-2 each 4006381333931.
const PACK_VIEW = new Map([
  ["03041090004827", { sku: "SKU-1", level: "EACH", unitsPerPack: 1 }],
  ["13041090004824", { sku: "SKU-1", level: "CASE", unitsPerPack: 12 }],
  ["04006381333931", { sku: "SKU-2", level: "EACH", unitsPerPack: 1 }],
]);
const gtinCheckDigitOk = (d) => {
  let sum = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(d[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
};

let stations, tasks, idem, log, dropNext;

function seed() {
  stations = new Map();
  idem = new Map();
  log = [];
  dropNext = false;
  tasks = new Map();
  const add = (t) => tasks.set(t.id, { status: "PENDING", fragile: false, giftWrap: false, ...t });
  add({ id: "20260101T120000.000000000", type: "PICK", cpt: "2026-01-01T18:00:00Z", orderRef: "order-42", requiredCapabilities: ["pick"] });
  add({ id: "20260101T120100.000000000", type: "PICK", cpt: "2026-01-01T19:00:00Z", orderRef: "order-43", requiredCapabilities: ["pick"] });
}
seed();

const send = (res, status, body, extra = {}) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  res.writeHead(status, {
    ...(payload === undefined ? {} : { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" }),
    ...extra,
  });
  res.end(payload);
};
const problem = (res, status, slug, title, detail, instance) =>
  send(res, status, { type: `${ERR}/${slug}`, title, status, detail, ...(instance ? { instance } : {}) });

const view = (t) => {
  // `pick` (the plan) and `pickedEaches` are server-side only: TaskResponse does not expose them.
  const { id, type, status, cpt, orderRef, requiredCapabilities, fragile, giftWrap, leaseStationId, leaseExpiry, relocation, replenishment } = t;
  return { id, type, status, cpt, orderRef, requiredCapabilities, fragile, giftWrap, leaseStationId, leaseExpiry, relocation, replenishment };
};
const stationView = (s) => ({ id: s.id, capabilities: s.capabilities, occupied: s.occupant !== null, ...(s.locationCode ? { locationCode: s.locationCode } : {}) });
const leaseActive = (t) => t.status === "CLAIMED" && Date.parse(t.leaseExpiry) > Date.now();

function handle(path, method, body, res) {
  const instance = path;
  if (method === "POST" && path === `${BASE}/stations`) {
    if (!body?.stationId || !Array.isArray(body.capabilities) || body.capabilities.length === 0) {
      return problem(res, 400, "invalid-request", "The request is malformed or missing a required field", "stationId and capabilities are required");
    }
    const prev = stations.get(body.stationId);
    const s = { id: body.stationId, capabilities: body.capabilities, occupant: prev?.occupant ?? null, locationCode: body.locationCode };
    stations.set(s.id, s);
    return send(res, 201, stationView(s), { Location: `/stations/${s.id}` });
  }
  let m = path.match(new RegExp(`^${BASE}/stations/([^/]+)/(check-in|check-out|claim-next)$`));
  if (method === "POST" && m) {
    const [, rawId, op] = m;
    const s = stations.get(decodeURIComponent(rawId));
    if (!s) return problem(res, 404, "station-not-found", "Station not found", "usecases: station not found", instance);
    if (op === "check-in") {
      if (!body?.occupantId) return problem(res, 400, "invalid-request", "The request is malformed or missing a required field", "occupantId is required", instance);
      if (s.occupant !== null) return problem(res, 409, "station-occupied", "Station is already occupied", "station: already occupied", instance);
      s.occupant = body.occupantId;
      return send(res, 200, stationView(s));
    }
    if (op === "check-out") {
      if (s.occupant === null) return problem(res, 409, "station-not-occupied", "Station is not occupied", "station: not occupied", instance);
      s.occupant = null;
      return send(res, 200, stationView(s));
    }
    const wanted = body?.taskType;
    // Mirrors the real server: claim-next validates against AnyTaskType, which does not list BREAK_CASE (docs/api-contract.md).
    if (wanted === "BREAK_CASE") return problem(res, 400, "invalid-request", "The request is malformed or missing a required field", "taskType is not a claimable task type", instance);
    if (!wanted) return problem(res, 400, "invalid-request", "The request is malformed or missing a required field", "taskType is required", instance);
    const candidates = [...tasks.values()]
      .filter((t) => t.type === wanted && (t.status === "PENDING" || (t.status === "CLAIMED" && !leaseActive(t))))
      .filter((t) => (t.requiredCapabilities ?? []).every((c) => s.capabilities.includes(c)))
      .sort((a, b) => Date.parse(a.cpt ?? 0) - Date.parse(b.cpt ?? 0));
    const t = candidates[0];
    if (!t) return problem(res, 409, "no-claimable-task", "No claimable task for station capabilities", "usecases: no claimable task for station capabilities", instance);
    t.status = "CLAIMED";
    t.leaseStationId = s.id;
    t.leaseExpiry = new Date(Date.now() + LEASE_MS).toISOString();
    return send(res, 200, view(t));
  }
  m = path.match(new RegExp(`^${BASE}/tasks/([^/]+)/(scans|break-case)$`));
  if (method === "POST" && m) {
    const [, rawId, op] = m;
    const t = tasks.get(decodeURIComponent(rawId));
    if (!t) return problem(res, 404, "task-not-found", "Task not found", "usecases: task not found", instance);
    if (!body?.stationId) return problem(res, 400, "invalid-request", "The request is malformed or missing a required field", "stationId is required", instance);
    if (t.status === "COMPLETED") return problem(res, 409, "task-already-completed", "Task already completed", "task: already completed", instance);
    if (!leaseActive(t)) return problem(res, 409, "task-not-claimed", "Task is not currently claimed", "task: not claimed", instance);
    if (t.leaseStationId !== body.stationId) return problem(res, 409, "task-not-owner", "Station does not own the active claim on this task", "task: not owner", instance);
    if (op === "break-case") {
      if (t.type !== "BREAK_CASE") return problem(res, 409, "not-case-break-task", "The task is not a BREAK_CASE task", "task: not a BREAK_CASE task", instance);
      if (t.breakRejected) return problem(res, 409, "case-break-rejected", "inventory-storage rejected the case break", "ports: inventory-storage rejected the case break", instance);
      t.status = "COMPLETED";
      return send(res, 204);
    }
    // POST /tasks/{id}/scans: body {stationId, gtin, count?}; the strict body shape of PickScanRequest.
    const extra = Object.keys(body).filter((k) => !["stationId", "gtin", "count"].includes(k));
    if (extra.length > 0 || typeof body.gtin !== "string" || !/^([0-9]{8}|[0-9]{12,14})$/.test(body.gtin)) {
      return problem(res, 400, "invalid-request", "The request is malformed or missing a required field", "gtin is required (8, 12, 13 or 14 digits)", instance);
    }
    const count = body.count ?? 1;
    if (!Number.isInteger(count) || count < 1) return problem(res, 400, "invalid-request", "The request is malformed or missing a required field", "count must be >= 1", instance);
    if (!t.pick) return problem(res, 409, "no-pick-plan", "The task carries no pick plan to scan against", "task: the task carries no pick plan to scan against", instance);
    const gtin = body.gtin.padStart(14, "0");
    if (!gtinCheckDigitOk(gtin) || gtin[0] === "9") return problem(res, 409, "invalid-scanned-gtin", "The scanned text is not a valid GTIN", "usecases: scanned GTIN is invalid", instance);
    const level = PACK_VIEW.get(gtin);
    if (!level) return problem(res, 409, "unknown-gtin", "The scanned GTIN is not a known pack level", `usecases: scanned GTIN is not a known pack level: ${gtin}`, instance);
    if (level.sku !== t.pick.sku) return problem(res, 409, "scan-sku-mismatch", "The scanned GTIN is not the SKU of this pick", "task: the scanned GTIN is not the SKU of this pick", instance);
    if (level.level !== t.pick.unit) return problem(res, 409, "scan-level-mismatch", "The scanned pack level does not match the pick unit", "task: the scanned pack level does not match the pick unit", instance);
    const added = count * level.unitsPerPack;
    const picked = (t.pickedEaches ?? 0) + added;
    if (picked > t.pick.plannedEaches) return problem(res, 409, "pick-over-quantity", "The scan would pick more than the planned quantity", "task: the scan would pick more than the planned quantity", instance);
    t.pickedEaches = picked;
    return send(res, 200, { scannedGtin: gtin, sku: level.sku, level: level.level, addedEaches: added, pickedEaches: picked, plannedEaches: t.pick.plannedEaches });
  }
  m = path.match(new RegExp(`^${BASE}/tasks/([^/]+)/(renew-lease|complete)$`));
  if (method === "POST" && m) {
    const [, rawId, op] = m;
    const t = tasks.get(decodeURIComponent(rawId));
    if (!t) return problem(res, 404, "task-not-found", "Task not found", "usecases: task not found", instance);
    if (!body?.stationId) return problem(res, 400, "invalid-request", "The request is malformed or missing a required field", "stationId is required", instance);
    if (t.status === "COMPLETED") return problem(res, 409, "task-already-completed", "Task already completed", "task: already completed", instance);
    if (!leaseActive(t)) return problem(res, 409, "task-not-claimed", "Task is not currently claimed", "task: not claimed", instance);
    if (t.leaseStationId !== body.stationId) return problem(res, 409, "task-not-owner", "Station does not own the active claim on this task", "task: not owner", instance);
    if (op === "renew-lease") {
      t.leaseExpiry = new Date(Date.now() + LEASE_MS).toISOString();
      return send(res, 204);
    }
    const { quantity, fromBin, toBin } = body;
    if (t.type === "BREAK_CASE") {
      return problem(res, 409, "case-break-completion-required", "A BREAK_CASE task completes only through POST /tasks/{id}/break-case", "task: a BREAK_CASE task completes only through the case break", instance);
    }
    if (t.type === "RELOCATE") {
      if (quantity === undefined) return problem(res, 422, "relocation-confirmation-required", "A RELOCATE task completes only with the confirmed quantity and the bins the move left open", "task: confirmation required", instance);
      const r = t.relocation ?? {};
      const bad = (r.fromBin ? fromBin !== undefined && fromBin !== r.fromBin : !fromBin) || (r.toBin ? toBin !== undefined && toBin !== r.toBin : !toBin) || (fromBin && fromBin === toBin);
      if (bad) return problem(res, 422, "invalid-relocation-confirmation", "Invalid relocation confirmation", "task: invalid confirmation", instance);
    } else if (t.type === "REPLENISH") {
      const r = t.replenishment ?? {};
      if (quantity === undefined) return problem(res, 422, "replenishment-confirmation-required", "A REPLENISH task completes only with the counted quantity", "task: confirmation required", instance);
      if (!(Number.isInteger(quantity) && quantity >= 1) || (fromBin !== undefined && fromBin !== r.fromBin) || (toBin !== undefined && toBin !== r.toBin)) {
        return problem(res, 422, "invalid-replenishment-confirmation", "Invalid replenishment confirmation", "task: invalid confirmation", instance);
      }
    } else if (quantity !== undefined || fromBin !== undefined || toBin !== undefined) {
      return problem(res, 422, "not-relocation-task", "Not a relocation task", "task: not a relocation task", instance);
    }
    t.status = "COMPLETED";
    return send(res, 204);
  }
  m = path.match(new RegExp(`^${BASE}/queues/([^/]+)/depth$`));
  if (method === "GET" && m) {
    const type = decodeURIComponent(m[1]);
    return send(res, 200, { taskType: type, depth: [...tasks.values()].filter((t) => t.type === type && t.status === "PENDING").length });
  }
  if (method === "GET" && (path === `${BASE}/healthz` || path === `${BASE}/readyz`)) return send(res, 200, { status: "ok" });
  return problem(res, 404, "not-found", "No such route", `${method} ${path}`);
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      return problem(res, 400, "invalid-request", "The request is malformed or missing a required field", "malformed JSON");
    }
    const path = url.pathname;

    if (path.startsWith("/__stub/")) {
      if (path === "/__stub/log") return send(res, 200, log);
      if (path === "/__stub/reset") return (seed(), send(res, 204));
      if (path === "/__stub/drop-next-response") return ((dropNext = true), send(res, 204));
      if (path === "/__stub/claim") {
        // Lease a specific task to a station without claim-next (how a BREAK_CASE task reaches a station
        // in the e2e: claim-next does not offer the type). Returns the TaskResponse the station would hold.
        const t = tasks.get(body?.taskId);
        if (!t || !stations.get(body?.stationId)) return send(res, 404, { error: "unknown task or station" });
        t.status = "CLAIMED";
        t.leaseStationId = body.stationId;
        t.leaseExpiry = new Date(Date.now() + LEASE_MS).toISOString();
        return send(res, 200, view(t));
      }
      if (path === "/__stub/tasks") {
        tasks.set(body.id, { status: "PENDING", fragile: false, giftWrap: false, ...body });
        return send(res, 201, body);
      }
      return send(res, 404, { error: "unknown control" });
    }

    if (req.method === "POST") {
      const key = req.headers["idempotency-key"];
      const entry = { method: req.method, path, key: key ?? null, body: body ?? null, replayed: false };
      log.push(entry);
      if (!key) return problem(res, 400, "idempotency-key-required", "Idempotency-Key header is required", "Send a caller-supplied Idempotency-Key header.", path);
      const stored = idem.get(key);
      if (stored) {
        if (stored.fingerprint !== `${path}\n${JSON.stringify(body ?? null)}`) {
          return problem(res, 422, "idempotency-key-reused", "Idempotency-Key was already used with a different request", "Use a new Idempotency-Key for a genuinely different request.", path);
        }
        entry.replayed = true;
        res.writeHead(stored.status, stored.headers);
        return res.end(stored.payload);
      }
      // Capture what handle() writes so the same bytes can be replayed for this key.
      const captured = { status: 200, headers: {}, payload: "" };
      const realWriteHead = res.writeHead.bind(res);
      const realEnd = res.end.bind(res);
      let drop = dropNext;
      dropNext = false;
      res.writeHead = (status, headers) => ((captured.status = status), (captured.headers = headers ?? {}), res);
      res.end = (payload) => {
        captured.payload = payload ?? "";
        idem.set(key, { ...captured, fingerprint: `${path}\n${JSON.stringify(body ?? null)}` });
        if (drop) return req.socket.destroy(); // applied, answer lost
        realWriteHead(captured.status, captured.headers);
        return realEnd(captured.payload);
      };
      return handle(path, req.method, body, res);
    }
    return handle(path, req.method ?? "GET", body, res);
  });
}).listen(PORT, () => console.log(`stub fulfillment-execution on http://localhost:${PORT}${BASE} (lease ${LEASE_MS} ms)`));
