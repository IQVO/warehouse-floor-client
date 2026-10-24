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
// It also stands in for inbound-receiving's receiving-dock endpoints under
// /api/inbound-receiving (seed receipt rcpt-stub-1): GET /receipts, GET
// /receipts/{id}, POST /receipts/{id}/scans and /close, GET
// /receipts/{id}/cartons/{lpn}/label. Seeded scans: SSCC 340123450000000017
// (SKU-1, 20 eaches), 340123450000000024 (a MIXED carton: SKU-1 x4, SKU-2 x3),
// 340123450000000031 (over the weight limit -> CartonOverLimit, still accepted);
// case GTIN 13041090004824 (12 eaches per case, no carton label -> UnlabelledCarton
// and an internal LPN); each GTIN 03041090004827 (SKU-1). A repeated SSCC is a
// 200 accepted=false DuplicateSscc. Quantities are multiplied HERE, like the server.
//
// Test controls (not part of the real API):
//   POST /__stub/reset               clear all state, reseed tasks
//   POST /__stub/tasks               add a task (JSON: a TaskResponse-like object)
//   POST /__stub/drop-next-response  apply the next command, then cut the connection before answering
//   GET  /__stub/log                 every command received (method, path, key, body, replayed)
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 8787);
const LEASE_MS = Number(process.env.STUB_LEASE_MS ?? 300_000);
const BASE = "/api/fulfillment-execution";
const ERR = "https://errors.fulfillment-execution.warehouse-systems.dev";
const IR = "/api/inbound-receiving";
const IR_ERR = "https://errors.inbound-receiving.warehouse-systems.dev";
const CASE_UNITS = 12;
const SSCC_CARTONS = {
  "340123450000000017": { kind: "HOMOGENEOUS_CASE", contents: [{ lineNo: 1, sku: "SKU-1", gtin: "03041090004827", qty: 20 }] },
  "340123450000000024": { kind: "MIXED", contents: [{ lineNo: 1, sku: "SKU-1", gtin: "03041090004827", qty: 4 }, { lineNo: 2, sku: "SKU-2", gtin: "03041090004828", qty: 3 }] },
  "340123450000000031": { kind: "HOMOGENEOUS_CASE", overLimit: true, contents: [{ lineNo: 1, sku: "SKU-1", gtin: "03041090004827", qty: 10 }] },
};

let stations, tasks, idem, log, dropNext, receipt, lpnSeq;

function seed() {
  stations = new Map();
  idem = new Map();
  log = [];
  dropNext = false;
  tasks = new Map();
  lpnSeq = 0;
  receipt = {
    receiptId: "rcpt-stub-1",
    asnNumber: "ASN-1001",
    doorCode: "WH1-DOCK-IN-01",
    state: "Open",
    lines: [
      { lineNo: 1, sku: "SKU-1", expectedQty: 40, receivedGood: 0, receivedDamaged: 0 },
      { lineNo: 2, sku: "SKU-2", expectedQty: 5, receivedGood: 0, receivedDamaged: 0 },
    ],
    openedAt: "2026-10-24T08:00:00Z",
    discrepancies: [],
    version: 1,
    cartons: [],
  };
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
  const { id, type, status, cpt, orderRef, requiredCapabilities, fragile, giftWrap, leaseStationId, leaseExpiry, relocation, replenishment } = t;
  return { id, type, status, cpt, orderRef, requiredCapabilities, fragile, giftWrap, leaseStationId, leaseExpiry, relocation, replenishment };
};
const stationView = (s) => ({ id: s.id, capabilities: s.capabilities, occupied: s.occupant !== null, ...(s.locationCode ? { locationCode: s.locationCode } : {}) });
const leaseActive = (t) => t.status === "CLAIMED" && Date.parse(t.leaseExpiry) > Date.now();

const receiptView = (r) => {
  const { cartons: _c, ...rest } = r;
  return rest;
};
const irProblem = (res, status, slug, title, instance) => send(res, status, { type: `${IR_ERR}/${slug}`, title, status, detail: `usecases: ${slug}`, instance });
const carton = (lpn, kind, contents, sscc) => ({
  lpn, ...(sscc ? { sscc } : {}), kind, status: "Accepted", sealed: true, receivedAt: new Date().toISOString(),
  contents: contents.map((c) => ({ ...c, condition: "Good" })),
});
const book = (r, sku, qty) => {
  const line = r.lines.find((l) => l.sku === sku);
  if (line) line.receivedGood += qty;
};

function handleReceiving(path, method, body, res) {
  if (method === "GET" && path === `${IR}/receipts`) return send(res, 200, { items: [receiptView(receipt)] });
  let m = path.match(new RegExp(`^${IR}/receipts/([^/]+)(?:/(scans|close|cartons/([^/]+)/label))?$`));
  if (!m) return irProblem(res, 404, "resource-not-found", "No such route", path);
  const [, rawId, sub, rawLpn] = m;
  if (decodeURIComponent(rawId) !== receipt.receiptId) return irProblem(res, 404, "receipt-not-found", "Receipt not found", path);
  if (method === "GET" && sub === undefined) return send(res, 200, receiptView(receipt));
  if (method === "GET" && rawLpn !== undefined) {
    const c = receipt.cartons.find((x) => x.lpn === decodeURIComponent(rawLpn));
    if (!c) return irProblem(res, 404, "carton-not-found", "Carton not found", path);
    const skus = [...new Set(c.contents.map((x) => x.sku))];
    return send(res, 200, {
      lpn: c.lpn, symbology: "CODE128", humanReadable: c.sscc ? `(00)${c.sscc}` : c.lpn,
      ...(skus.length === 1 ? { sku: skus[0] } : {}), units: c.contents.reduce((n, x) => n + x.qty, 0), receivedAt: c.receivedAt,
    });
  }
  if (method !== "POST") return irProblem(res, 404, "resource-not-found", "No such route", path);
  if (receipt.state === "Closed") return irProblem(res, 409, "receipt-closed", "Receipt is closed", path);
  if (sub === "close") {
    receipt.state = "Closed";
    receipt.closedAt = new Date().toISOString();
    receipt.discrepancies = receipt.lines.flatMap((l) => {
      const got = l.receivedGood + l.receivedDamaged;
      const base = { lineNo: l.lineNo, sku: l.sku, expectedQty: l.expectedQty, receivedQty: got, damagedQty: l.receivedDamaged };
      return got < l.expectedQty ? [{ ...base, kind: "Short" }] : got > l.expectedQty ? [{ ...base, kind: "Over" }] : [];
    });
    receipt.version += 1;
    return send(res, 200, receiptView(receipt));
  }
  // POST .../scans
  const { kind, id, qty, countedContents } = body ?? {};
  if (body?.scan === undefined && (!kind || !id)) return irProblem(res, 400, "invalid-scan", "Invalid scan", path);
  const result = (status, accepted, cartons, discrepancies) => {
    receipt.version += 1;
    return send(res, status, { kind, accepted, lines: receipt.lines, cartons, discrepancies, version: receipt.version });
  };
  if (kind === "SSCC") {
    const def = SSCC_CARTONS[id];
    if (!def) return result(200, false, [], [{ kind: "UnexpectedCarton", sscc: id }]);
    if (receipt.cartons.some((c) => c.sscc === id)) return result(200, false, [], [{ kind: "DuplicateSscc", sscc: id }]);
    if (countedContents !== undefined && def.kind !== "MIXED") return irProblem(res, 422, "counted-contents-not-mixed", "Counted contents only apply to a MIXED carton", path);
    const findings = [];
    let contents = def.contents;
    if (countedContents !== undefined) {
      contents = def.contents.map((c) => ({ ...c, qty: countedContents.find((x) => x.sku === c.sku)?.qty ?? 0 }));
      for (const c of def.contents) {
        const counted = countedContents.find((x) => x.sku === c.sku)?.qty ?? 0;
        if (counted !== c.qty) findings.push({ kind: "MixedCartonContentMismatch", sscc: id, expected: `${c.sku}:${c.qty}`, actual: `${c.sku}:${counted}` });
      }
    }
    if (def.overLimit) findings.push({ kind: "CartonOverLimit", sscc: id, expected: "grossWeightG:25000", actual: "grossWeightG:31000" });
    const c = carton(id, def.kind, contents, id);
    receipt.cartons.push(c);
    for (const x of contents) book(receipt, x.sku, x.qty);
    return result(201, true, [c], findings);
  }
  if (kind === "CASE_GTIN" && id === "13041090004824") {
    const cases = qty && qty > 0 ? qty : 1;
    const out = [];
    for (let i = 0; i < cases; i += 1) {
      lpnSeq += 1;
      const c = carton(`LPN-STUB${String(lpnSeq).padStart(6, "0")}`, "HOMOGENEOUS_CASE", [{ lineNo: 1, sku: "SKU-1", gtin: "03041090004827", qty: CASE_UNITS }]);
      receipt.cartons.push(c);
      out.push(c);
    }
    book(receipt, "SKU-1", cases * CASE_UNITS);
    return result(201, true, out, [{ kind: "UnlabelledCarton" }]);
  }
  if (kind === "EACH_GTIN" && id === "03041090004827") {
    book(receipt, "SKU-1", qty && qty > 0 ? qty : 1);
    return result(201, true, [], []);
  }
  if (kind === "CASE_GTIN" || kind === "EACH_GTIN") return result(200, false, [], [{ kind: "UnknownGtin", actual: id }]);
  return irProblem(res, 422, "scan-kind-mismatch", "Scan kind mismatch", path);
}

function handle(path, method, body, res) {
  const instance = path;
  if (path.startsWith(`${IR}/`)) return handleReceiving(path, method, body, res);
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
