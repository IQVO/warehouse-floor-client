// In-memory stand-in for yard-management's REST API (apis/openapi.yaml on the
// service branch), for scripts/stub-api.mjs. Same rules as the rest of the stub:
// shapes, enums and problem slugs are the OpenAPI's; behaviour is the smallest
// that lets the gate, hostler and dock screens run a whole day.
//
// Site WH1. Places: yard spots WH1-YARD-01..05, holding spots WH1-HOLD-01..02,
// doors WH1-DOCK-IN-01/02 and WH1-DOCK-OUT-01. Appointments appt-stub-1 (door
// WH1-DOCK-IN-01, expected seal SEAL-100, ASN-2001) and appt-stub-2 (door
// WH1-DOCK-IN-02, ASN-2002). Seed: parked trailer SEED-TRL-1 at WH1-YARD-01 and a
// REQUESTED hostler move RELOCATE to WH1-YARD-02 (band 3), so a hostler has work.
//
// Stub-only choices (the spec leaves them open): a lease that lapsed is swept on the
// next call, putting the move back to REQUESTED and the trailer back where it was;
// a DROP trailer whose door work completes gets a FROM_DOOR move to the first free
// yard spot (ClearDoorAfterWork). Seal mismatch is FLAG by default (POST
// /__stub/yard-policy {"sealMismatchAction":"REJECT"} switches it).
export const YARD = "/api/yard-management";
const ERR = "https://errors.yard-management.warehouse-systems.dev";
const SITE = "WH1";
const YARD_SPOTS = [1, 2, 3, 4, 5].map((n) => `WH1-YARD-0${n}`);
const HOLDING = ["WH1-HOLD-01", "WH1-HOLD-02"];
const DOORS = ["WH1-DOCK-IN-01", "WH1-DOCK-IN-02", "WH1-DOCK-OUT-01"];
const APPOINTMENTS = {
  "appt-stub-1": { door: "WH1-DOCK-IN-01", seal: "SEAL-100", asn: ["ASN-2001"] },
  "appt-stub-2": { door: "WH1-DOCK-IN-02", seal: null, asn: ["ASN-2002"] },
};
const PURPOSES = ["DROP", "LIVE_UNLOAD", "LIVE_LOAD", "PICKUP", "BOBTAIL"];
const REASONS = ["APPOINTMENT_REQUIRED", "UNKNOWN_APPOINTMENT", "SEAL_MISMATCH", "TRAILER_ALREADY_ON_SITE", "SITE_REQUEST"];
const KINDS = ["DRY_VAN", "REEFER", "FLATBED", "CONTAINER"];
const LOADS = ["EMPTY", "LOADED", "PARTIAL"];

export function createYardStub({ send, leaseMs }) {
  let visits, trailers, moves, seq, policy;
  const iso = (ms = Date.now()) => new Date(ms).toISOString();
  const id = (p) => `${p}-stub-${++seq}`;

  function reset() {
    visits = [];
    trailers = [];
    moves = [];
    seq = 0;
    policy = { sealMismatchAction: "FLAG" };
    const t = newTrailer({ unitNumber: "SEED-TRL-1", kind: "DRY_VAN", loadState: "EMPTY" }, null, null, "PARKED", { kind: "SPOT", code: YARD_SPOTS[0] });
    trailers.push(t);
    addMove(t, "HOSTLER", t.location, { kind: "SPOT", code: YARD_SPOTS[1] }, "RELOCATE", { band: 3, dueBy: iso(Date.now() + 3_600_000) }, "REQUESTED");
  }

  const problem = (res, status, slug, title, path) => send(res, status, { type: `${ERR}/${slug}`, title, status, detail: title, instance: path });

  function newTrailer(t, visit, appt, state, location) {
    return {
      trailerId: id("trl"), siteId: SITE, unitNumber: t.unitNumber, carrierScac: t.carrierScac ?? null, kind: t.kind, loadState: t.loadState, state,
      location: location ?? null, doorWork: state === "DOCKED" ? "WAITING" : null,
      seal: { number: t.sealNumber ?? null, state: t.sealNumber ? "INTACT" : "NONE" }, hold: null, asnNumbers: appt ? appt.asn : [], outboundRef: null,
      visitId: visit?.visitId ?? null, appointmentId: visit?.appointmentId ?? null, arrivedAt: iso(), departedAt: null, openMoveId: null, version: 1,
    };
  }
  function addMove(trailer, performer, from, to, reason, priority, state) {
    const m = {
      moveId: id("mv"), siteId: SITE, trailerId: trailer.trailerId, appointmentId: trailer.appointmentId, performer, from: from ?? null, to, reason, priority,
      state, hostlerRef: null, leaseExpiresAt: null, actualLocation: null, claimedAt: state === "CLAIMED" ? iso() : null, completedAt: null, requestedAt: iso(), version: 1,
    };
    moves.push(m);
    trailer.openMoveId = m.moveId;
    return m;
  }
  const occupant = (code) => trailers.find((t) => t.state !== "DEPARTED" && t.location?.code === code) ?? moves.find((m) => ["REQUESTED", "CLAIMED"].includes(m.state) && m.to.code === code);
  const known = (loc) => loc && ((loc.kind === "DOOR" && DOORS.includes(loc.code)) || (loc.kind === "SPOT" && [...YARD_SPOTS, ...HOLDING].includes(loc.code)));
  const freeOf = (codes) => codes.find((c) => !occupant(c));
  const place = (t, loc) => {
    t.location = loc;
    t.state = loc.kind === "DOOR" ? "DOCKED" : "PARKED";
    t.doorWork = loc.kind === "DOOR" ? "WAITING" : null;
  };

  function sweepLeases() {
    for (const m of moves) {
      if (m.state !== "CLAIMED" || m.performer !== "HOSTLER" || Date.parse(m.leaseExpiresAt) > Date.now()) continue;
      const t = trailers.find((x) => x.trailerId === m.trailerId);
      if (m.from) place(t, m.from);
      Object.assign(m, { state: "REQUESTED", hostlerRef: null, leaseExpiresAt: null, claimedAt: null, version: m.version + 1 });
    }
  }

  function page(res, items, query) {
    const limit = Math.min(Math.max(Number(query.get("limit") ?? 100) || 100, 1), 500);
    const start = Number(query.get("cursor") ?? 0) || 0;
    const slice = items.slice(start, start + limit);
    return send(res, 200, { items: slice, ...(start + limit < items.length ? { nextCursor: String(start + limit) } : {}) });
  }
  const by = (query, key, field = key) => (x) => query.get(key) === null || x[field] === query.get(key);

  function checkIn(res, body, path) {
    const b = body ?? {};
    const list = Array.isArray(b.trailers) ? b.trailers : [];
    if (b.siteId !== SITE || !b.carrier || !b.tractorPlate || !PURPOSES.includes(b.purpose)) return problem(res, 422, "validation", "Validation failed", path);
    if (list.some((t) => !t.unitNumber || !KINDS.includes(t.kind) || !LOADS.includes(t.loadState))) return problem(res, 422, "validation", "Validation failed", path);
    const appt = b.appointmentId ? APPOINTMENTS[b.appointmentId] : undefined;
    if (b.appointmentId && (!appt || list.length !== 1)) return problem(res, 422, "unknown-appointment", "Unknown appointment", path);
    if (!["BOBTAIL", "PICKUP"].includes(b.purpose) && list.length === 0) return problem(res, 422, "validation", "Validation failed", path);
    if (visits.some((v) => v.state === "CHECKED_IN" && v.tractorPlate === b.tractorPlate)) return problem(res, 409, "visit-already-open", "A visit is already open for this tractor plate", path);
    const units = list.map((t) => t.unitNumber);
    if (new Set(units).size !== units.length || trailers.some((t) => t.state !== "DEPARTED" && units.includes(t.unitNumber))) return problem(res, 409, "trailer-already-on-site", "Trailer is already on site", path);

    const visit = {
      visitId: id("visit"), siteId: SITE, carrier: b.carrier, carrierScac: b.carrierScac ?? null, tractorPlate: b.tractorPlate, driverRef: b.driverRef ?? null,
      purpose: b.purpose, appointmentId: b.appointmentId ?? null, state: "CHECKED_IN", rejectionReason: null, trailersIn: [], trailersOut: [], arrivedAt: iso(), departedAt: null, version: 1,
    };
    const mismatch = appt?.seal && list.some((t) => t.sealNumber && t.sealNumber !== appt.seal);
    if (mismatch && policy.sealMismatchAction === "REJECT") {
      visits.push({ ...visit, state: "REJECTED", rejectionReason: "SEAL_MISMATCH" });
      return send(res, 201, { visit: visits.at(-1), trailers: [], moves: [] });
    }
    // Plan every place first, so a full yard refuses the whole check-in and persists nothing.
    const reserved = new Set();
    const plan = [];
    for (const t of list) {
      const free = (codes) => codes.find((c) => !occupant(c) && !reserved.has(c));
      let to;
      if (appt && free([appt.door])) to = { kind: "DOOR", code: appt.door };
      else {
        const code = appt ? free(YARD_SPOTS) : (free(HOLDING) ?? free(YARD_SPOTS));
        if (!code) return problem(res, 409, "no-free-spot", "No free spot", path);
        to = { kind: "SPOT", code };
      }
      reserved.add(to.code);
      plan.push({ t, to });
    }
    visits.push(visit);
    const out = { visit, trailers: [], moves: [] };
    for (const { t, to } of plan) {
      const tr = newTrailer(t, visit, appt, "IN_MOVE", null);
      trailers.push(tr);
      visit.trailersIn.push(tr.trailerId);
      const reason = to.kind === "DOOR" ? "TO_DOOR" : appt ? "TO_SPOT" : "TO_HOLDING";
      out.moves.push(addMove(tr, "VISITING_DRIVER", null, to, reason, { band: 1, dueBy: null }, "CLAIMED"));
      out.trailers.push(tr);
    }
    return send(res, 201, out);
  }

  function claim(res, body, path) {
    sweepLeases();
    if (!body?.siteId || !body?.hostlerRef) return problem(res, 400, "malformed-request-body", "Malformed request body", path);
    if (moves.some((m) => m.state === "CLAIMED" && m.performer === "HOSTLER" && m.hostlerRef === body.hostlerRef)) return problem(res, 409, "hostler-busy", "Hostler already holds a claimed move", path);
    const due = (m) => (m.priority.dueBy ? Date.parse(m.priority.dueBy) : Infinity);
    const next = moves
      .filter((m) => m.state === "REQUESTED" && m.performer === "HOSTLER" && m.siteId === body.siteId)
      .sort((a, b) => a.priority.band - b.priority.band || due(a) - due(b) || Date.parse(a.requestedAt) - Date.parse(b.requestedAt))[0];
    if (!next) return problem(res, 404, "no-claimable-move", "No claimable move", path);
    Object.assign(next, { state: "CLAIMED", hostlerRef: body.hostlerRef, claimedAt: iso(), leaseExpiresAt: iso(Date.now() + leaseMs), version: next.version + 1 });
    const t = trailers.find((x) => x.trailerId === next.trailerId);
    Object.assign(t, { state: "IN_MOVE", location: null, doorWork: null, version: t.version + 1 });
    return send(res, 201, next);
  }

  function completeMove(res, m, body, path) {
    sweepLeases();
    if (m.state !== "CLAIMED") return problem(res, 409, "illegal-transition", "Illegal transition", path);
    if (m.performer === "HOSTLER" && body?.hostlerRef !== m.hostlerRef) return problem(res, 409, "not-lease-holder", "Only the lease holder completes the move", path);
    const actual = body?.actualLocation ?? m.to;
    if (!known(actual)) return problem(res, 422, "unknown-location", "Unknown location", path);
    const same = actual.code === m.to.code && actual.kind === m.to.kind;
    if (!same && !(typeof body?.deviationNote === "string" && body.deviationNote.trim() !== "")) return problem(res, 422, "unexplained-destination", "A location other than the destination needs an explanation", path);
    const holder = occupant(actual.code);
    if (holder && holder !== m && holder.moveId !== m.moveId) return problem(res, 409, "location-occupied", "The location already holds a trailer", path);
    const t = trailers.find((x) => x.trailerId === m.trailerId);
    place(t, actual);
    Object.assign(t, { openMoveId: null, version: t.version + 1 });
    Object.assign(m, { state: "COMPLETED", actualLocation: actual, completedAt: iso(), version: m.version + 1 });
    return send(res, 200, m);
  }

  function doorWork(res, t, op, body, path) {
    if (t.state !== "DOCKED" || t.doorWork !== (op === "start" ? "WAITING" : "IN_PROGRESS")) return problem(res, 409, "illegal-transition", "Illegal transition", path);
    if (op === "start" && t.hold) return problem(res, 409, "trailer-on-hold", "Trailer is on hold", path);
    if (op === "complete" && body?.loadState !== undefined && !LOADS.includes(body.loadState)) return problem(res, 422, "validation", "Validation failed", path);
    t.doorWork = op === "start" ? "IN_PROGRESS" : "DONE";
    if (op === "complete" && body?.loadState) t.loadState = body.loadState;
    t.version += 1;
    const visit = visits.find((v) => v.visitId === t.visitId);
    const spot = freeOf(YARD_SPOTS);
    if (op === "complete" && visit?.purpose === "DROP" && spot) addMove(t, "HOSTLER", t.location, { kind: "SPOT", code: spot }, "FROM_DOOR", { band: 5, dueBy: null }, "REQUESTED");
    return send(res, 200, t);
  }

  function checkOut(res, v, body, path) {
    if (v.state !== "CHECKED_IN") return problem(res, 409, "illegal-transition", "Illegal transition", path);
    if (!Array.isArray(body?.trailersOut)) return problem(res, 400, "malformed-request-body", "Malformed request body", path);
    const taking = [];
    for (const { trailerId } of body.trailersOut) {
      const t = trailers.find((x) => x.trailerId === trailerId && x.state !== "DEPARTED");
      if (!t) return problem(res, 404, "trailer-not-found", "Trailer not found", path);
      if (t.openMoveId || !(t.state === "PARKED" || (t.state === "DOCKED" && t.doorWork === "DONE"))) return problem(res, 409, "trailer-not-released", "Trailer is not released", path);
      if (["LIVE_LOAD", "PICKUP"].includes(v.purpose) && t.loadState === "LOADED" && t.seal.state === "NONE") return problem(res, 409, "seal-required", "A loaded outbound trailer needs a seal", path);
      taking.push(t);
    }
    for (const t of taking) Object.assign(t, { state: "DEPARTED", location: null, doorWork: null, departedAt: iso(), version: t.version + 1 });
    Object.assign(v, { state: "CHECKED_OUT", trailersOut: taking.map((t) => t.trailerId), departedAt: iso(), version: v.version + 1 });
    return send(res, 200, v);
  }

  function reject(res, b, path) {
    if (!b?.siteId || !b.carrier || !b.tractorPlate || !REASONS.includes(b.reason)) return problem(res, 422, "validation", "Validation failed", path);
    const v = {
      visitId: id("visit"), siteId: b.siteId, carrier: b.carrier, carrierScac: b.carrierScac ?? null, tractorPlate: b.tractorPlate, driverRef: null, purpose: "BOBTAIL",
      appointmentId: b.appointmentId ?? null, state: "REJECTED", rejectionReason: b.reason, trailersIn: [], trailersOut: [], arrivedAt: iso(), departedAt: null, version: 1,
    };
    visits.push(v);
    return send(res, 201, v);
  }

  function handle(path, method, body, res, query = new URLSearchParams()) {
    const rest = path.slice(YARD.length);
    if (method === "GET") {
      sweepLeases();
      if (rest === "/visits") return page(res, visits.filter(by(query, "siteId")).filter(by(query, "state")).filter(by(query, "tractorPlate")).reverse(), query);
      if (rest === "/trailers") {
        const state = query.get("state");
        return page(res, trailers.filter((t) => (state ? t.state === state : t.state !== "DEPARTED")).filter(by(query, "siteId")).filter(by(query, "kind")).filter(by(query, "unitNumber")).filter((t) => query.get("locationCode") === null || t.location?.code === query.get("locationCode")), query);
      }
      if (rest === "/moves") return page(res, moves.filter(by(query, "siteId")).filter(by(query, "state")).filter(by(query, "trailerId")), query);
      const one = rest.match(/^\/(visits|trailers)\/([^/]+)$/);
      if (one) {
        const item = (one[1] === "visits" ? visits : trailers).find((x) => (one[1] === "visits" ? x.visitId : x.trailerId) === decodeURIComponent(one[2]));
        return item ? send(res, 200, item) : problem(res, 404, one[1] === "visits" ? "visit-not-found" : "trailer-not-found", "Not found", path);
      }
      return problem(res, 404, "not-found", "No such route", path);
    }
    if (method !== "POST") return problem(res, 404, "not-found", "No such route", path);
    if (rest === "/visits") return checkIn(res, body, path);
    if (rest === "/visit-rejections") return reject(res, body, path);
    if (rest === "/moves/claims") return claim(res, body, path);
    const sub = rest.match(/^\/(visits|moves|trailers)\/([^/]+)\/(check-outs|completions|door-work-starts|door-work-completions)$/);
    if (!sub) return problem(res, 404, "not-found", "No such route", path);
    const ref = decodeURIComponent(sub[2]);
    if (sub[1] === "visits" && sub[3] === "check-outs") {
      const v = visits.find((x) => x.visitId === ref);
      return v ? checkOut(res, v, body, path) : problem(res, 404, "visit-not-found", "Visit not found", path);
    }
    if (sub[1] === "moves" && sub[3] === "completions") {
      const m = moves.find((x) => x.moveId === ref);
      return m ? completeMove(res, m, body, path) : problem(res, 404, "move-not-found", "Move not found", path);
    }
    if (sub[1] === "trailers" && sub[3].startsWith("door-work")) {
      const t = trailers.find((x) => x.trailerId === ref);
      return t ? doorWork(res, t, sub[3] === "door-work-starts" ? "start" : "complete", body, path) : problem(res, 404, "trailer-not-found", "Trailer not found", path);
    }
    return problem(res, 404, "not-found", "No such route", path);
  }

  /** Test controls under /__stub/. Returns false when the path is not a yard control. */
  function control(path, body, res) {
    if (path === "/__stub/yard-policy") {
      policy = { ...policy, ...body };
      send(res, 200, policy);
      return true;
    }
    return false;
  }

  reset();
  return { handle, reset, control };
}
