import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The stub is what the browser flow (scripts/e2e-yard-flow.mjs) and local work run
 * against, so every yard endpoint it stands in for is driven here over real HTTP.
 * Shapes are checked against the required properties of apis/openapi.yaml.
 */
const Y = "/api/yard-management";
const REQUIRED = {
  visit: ["visitId", "siteId", "carrier", "tractorPlate", "purpose", "state", "trailersIn", "trailersOut", "arrivedAt", "version"],
  trailer: ["trailerId", "siteId", "unitNumber", "kind", "loadState", "state", "seal", "asnNumbers", "arrivedAt", "version"],
  move: ["moveId", "siteId", "trailerId", "performer", "to", "reason", "priority", "state", "requestedAt", "version"],
};

interface Stub {
  proc: ChildProcess;
  base: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function start(leaseMs: number): Promise<Stub> {
  const port = await freePort();
  const proc = spawn(process.execPath, ["scripts/stub-api.mjs"], { env: { ...process.env, STUB_PORT: String(port), STUB_LEASE_MS: String(leaseMs) }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    proc.stdout?.on("data", (d: Buffer) => d.toString().includes("stub fulfillment-execution") && resolve());
    proc.on("exit", (code) => reject(new Error(`stub exited ${code}`)));
  });
  return { proc, base: `http://localhost:${port}` };
}

let n = 0;
async function call(stub: Stub, method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`${stub.base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "POST" ? { "Idempotency-Key": key ?? `k-${++n}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text === "" ? undefined : JSON.parse(text), type: res.headers.get("content-type") };
}

const has = (o: unknown, keys: string[]) => keys.every((k) => k in (o as object));
const problemSlug = (j: { type: string }) => j.type.split("/").pop();

let stub: Stub;
let shortLease: Stub;
beforeAll(async () => {
  [stub, shortLease] = await Promise.all([start(300_000), start(200)]);
}, 30_000);
afterAll(() => {
  stub.proc.kill();
  shortLease.proc.kill();
});

const checkIn = (body: object, key?: string) =>
  call(stub, "POST", `${Y}/visits`, { siteId: "WH1", carrier: "Acme", tractorPlate: "ABC1234", ...body }, key);
const trailerIn = (unitNumber: string, extra: object = {}) => ({ unitNumber, kind: "DRY_VAN", loadState: "LOADED", ...extra });

describe("stub-api: yard-management", () => {
  it("serves the whole live-unload day: check in, arrive, door work, check out", async () => {
    await call(stub, "POST", "/__stub/reset");
    const ci = await checkIn({ purpose: "LIVE_UNLOAD", appointmentId: "appt-stub-1", trailers: [trailerIn("UNL-1", { sealNumber: "SEAL-100" })] });
    expect(ci.status).toBe(201);
    expect(has(ci.json, ["visit", "trailers", "moves"])).toBe(true);
    expect(has(ci.json.visit, REQUIRED.visit)).toBe(true);
    expect(has(ci.json.trailers[0], REQUIRED.trailer)).toBe(true);
    const mv = ci.json.moves[0];
    expect(has(mv, REQUIRED.move)).toBe(true);
    expect(mv).toMatchObject({ performer: "VISITING_DRIVER", state: "CLAIMED", reason: "TO_DOOR", to: { kind: "DOOR", code: "WH1-DOCK-IN-01" }, from: null });
    expect(ci.json.trailers[0].asnNumbers).toEqual(["ASN-2001"]);

    const arrived = await call(stub, "POST", `${Y}/moves/${mv.moveId}/completions`, { actualLocation: mv.to });
    expect(arrived.status).toBe(200);
    expect(arrived.json).toMatchObject({ state: "COMPLETED", actualLocation: mv.to });

    const docked = await call(stub, "GET", `${Y}/trailers?siteId=WH1&state=DOCKED`);
    expect(docked.json.items).toHaveLength(1);
    expect(docked.json.items[0]).toMatchObject({ unitNumber: "UNL-1", doorWork: "WAITING", location: mv.to, openMoveId: null });
    const tid = docked.json.items[0].trailerId;

    expect((await call(stub, "POST", `${Y}/trailers/${tid}/door-work-completions`, {})).json).toSatisfy((j: { type: string }) => problemSlug(j) === "illegal-transition");
    const started = await call(stub, "POST", `${Y}/trailers/${tid}/door-work-starts`);
    expect(started.json.doorWork).toBe("IN_PROGRESS");

    const visitId = ci.json.visit.visitId;
    const early = await call(stub, "POST", `${Y}/visits/${visitId}/check-outs`, { trailersOut: [{ trailerId: tid }] });
    expect(early.status).toBe(409);
    expect(problemSlug(early.json)).toBe("trailer-not-released");

    const done = await call(stub, "POST", `${Y}/trailers/${tid}/door-work-completions`, { loadState: "EMPTY" });
    expect(done.json).toMatchObject({ doorWork: "DONE", loadState: "EMPTY" });

    const out = await call(stub, "POST", `${Y}/visits/${visitId}/check-outs`, { trailersOut: [{ trailerId: tid }] });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ state: "CHECKED_OUT", trailersOut: [tid] });
    expect((await call(stub, "GET", `${Y}/trailers/${tid}`)).json.state).toBe("DEPARTED");
    expect(problemSlug((await call(stub, "POST", `${Y}/visits/${visitId}/check-outs`, { trailersOut: [] })).json)).toBe("illegal-transition");
    expect((await call(stub, "GET", `${Y}/visits/${visitId}`)).json.state).toBe("CHECKED_OUT");
  });

  it("sends a walk-in to a holding spot, a taken door to a yard spot, and refuses what the rules refuse", async () => {
    await call(stub, "POST", "/__stub/reset");
    const walkIn = await checkIn({ purpose: "DROP", trailers: [trailerIn("WALK-1")] });
    expect(walkIn.json.moves[0]).toMatchObject({ reason: "TO_HOLDING", to: { kind: "SPOT", code: "WH1-HOLD-01" } });
    const second = await checkIn({ tractorPlate: "ZZZ1", purpose: "LIVE_UNLOAD", appointmentId: "appt-stub-2", trailers: [trailerIn("APPT-2")] });
    expect(second.json.moves[0].to.code).toBe("WH1-DOCK-IN-02");
    const taken = await checkIn({ tractorPlate: "ZZZ2", purpose: "LIVE_UNLOAD", appointmentId: "appt-stub-2", trailers: [trailerIn("APPT-3")] });
    expect(taken.json.moves[0]).toMatchObject({ reason: "TO_SPOT" });

    const slug = async (body: object) => problemSlug((await checkIn(body)).json);
    expect(await slug({ purpose: "DROP", trailers: [trailerIn("OTHER")] })).toBe("visit-already-open");
    expect(await slug({ tractorPlate: "Q1", purpose: "DROP", trailers: [trailerIn("WALK-1")] })).toBe("trailer-already-on-site");
    expect(await slug({ tractorPlate: "Q2", purpose: "DROP", appointmentId: "appt-nope", trailers: [trailerIn("Q2U")] })).toBe("unknown-appointment");
    expect(await slug({ tractorPlate: "Q3", purpose: "DROP", appointmentId: "appt-stub-1", trailers: [trailerIn("Q3A"), trailerIn("Q3B")] })).toBe("unknown-appointment");
    expect(await slug({ tractorPlate: "Q4", purpose: "DROP", trailers: [] })).toBe("validation");
    const bob = await checkIn({ tractorPlate: "BOB", purpose: "BOBTAIL" });
    expect(bob.json).toMatchObject({ trailers: [], moves: [] });
  });

  it("refuses with no-free-spot and persists nothing", async () => {
    await call(stub, "POST", "/__stub/reset");
    const many = ["A", "B", "C", "D", "E", "F"].map((u) => trailerIn(`FULL-${u}`));
    const r = await checkIn({ purpose: "DROP", trailers: many });
    expect(r.status).toBe(409);
    expect(problemSlug(r.json)).toBe("no-free-spot");
    expect((await call(stub, "GET", `${Y}/trailers?siteId=WH1`)).json.items).toHaveLength(1); // the seeded one
    expect((await call(stub, "GET", `${Y}/visits?siteId=WH1`)).json.items).toHaveLength(0);
  });

  it("replays a repeated Idempotency-Key, refuses a changed body, and demands a key", async () => {
    await call(stub, "POST", "/__stub/reset");
    const body = { purpose: "BOBTAIL" };
    const first = await checkIn(body, "same-key");
    const replay = await checkIn(body, "same-key");
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(replay.json.visit.visitId).toBe(first.json.visit.visitId);
    expect((await call(stub, "GET", `${Y}/visits?siteId=WH1`)).json.items).toHaveLength(1);
    expect(problemSlug((await checkIn({ purpose: "BOBTAIL", carrier: "Other" }, "same-key")).json)).toBe("idempotency-key-reused");
    const noKey = await fetch(`${stub.base}${Y}/visits`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(noKey.status).toBe(400);
  });

  it("runs the hostler's day: claim, busy, complete with a place and a reason, occupied", async () => {
    await call(stub, "POST", "/__stub/reset");
    expect((await call(stub, "POST", `${Y}/moves/claims`, { siteId: "WH1" })).status).toBe(400);
    const claimed = await call(stub, "POST", `${Y}/moves/claims`, { siteId: "WH1", hostlerRef: "host-1" });
    expect(claimed.status).toBe(201);
    expect(has(claimed.json, REQUIRED.move)).toBe(true);
    expect(claimed.json).toMatchObject({ performer: "HOSTLER", state: "CLAIMED", hostlerRef: "host-1", reason: "RELOCATE", priority: { band: 3 } });
    expect(Date.parse(claimed.json.leaseExpiresAt)).toBeGreaterThan(Date.now());

    expect(problemSlug((await call(stub, "POST", `${Y}/moves/claims`, { siteId: "WH1", hostlerRef: "host-1" })).json)).toBe("hostler-busy");
    expect(problemSlug((await call(stub, "POST", `${Y}/moves/claims`, { siteId: "WH1", hostlerRef: "host-2" })).json)).toBe("no-claimable-move");
    expect((await call(stub, "GET", `${Y}/moves?siteId=WH1&state=CLAIMED`)).json.items.map((m: { moveId: string }) => m.moveId)).toEqual([claimed.json.moveId]);

    const path = `${Y}/moves/${claimed.json.moveId}/completions`;
    expect(problemSlug((await call(stub, "POST", path, { hostlerRef: "host-2" })).json)).toBe("not-lease-holder");
    expect(problemSlug((await call(stub, "POST", path, { hostlerRef: "host-1", actualLocation: { kind: "SPOT", code: "WH1-YARD-04" } })).json)).toBe("unexplained-destination");
    expect(problemSlug((await call(stub, "POST", path, { hostlerRef: "host-1", actualLocation: { kind: "SPOT", code: "NOPE" }, deviationNote: "x" })).json)).toBe("unknown-location");
    const done = await call(stub, "POST", path, { hostlerRef: "host-1", actualLocation: { kind: "SPOT", code: "WH1-YARD-04" }, deviationNote: "03 was blocked" });
    expect(done.json).toMatchObject({ state: "COMPLETED", actualLocation: { code: "WH1-YARD-04" } });
    expect(problemSlug((await call(stub, "POST", path, { hostlerRef: "host-1" })).json)).toBe("illegal-transition");
    const parked = await call(stub, "GET", `${Y}/trailers?siteId=WH1&locationCode=WH1-YARD-04`);
    expect(parked.json.items[0]).toMatchObject({ unitNumber: "SEED-TRL-1", state: "PARKED" });
  });

  it("refuses a place that is taken, and queues a FROM_DOOR move for a dropped trailer", async () => {
    await call(stub, "POST", "/__stub/reset");
    const drop = await checkIn({ purpose: "DROP", appointmentId: "appt-stub-1", trailers: [trailerIn("DROP-1")] });
    const arrive = drop.json.moves[0];
    // WH1-YARD-01 holds the seeded trailer.
    const taken = await call(stub, "POST", `${Y}/moves/${arrive.moveId}/completions`, { actualLocation: { kind: "SPOT", code: "WH1-YARD-01" }, deviationNote: "try" });
    expect(problemSlug(taken.json)).toBe("location-occupied");
    await call(stub, "POST", `${Y}/moves/${arrive.moveId}/completions`, {});
    const tid = drop.json.trailers[0].trailerId;
    await call(stub, "POST", `${Y}/trailers/${tid}/door-work-starts`);
    await call(stub, "POST", `${Y}/trailers/${tid}/door-work-completions`, { loadState: "EMPTY" });
    const open = (await call(stub, "GET", `${Y}/moves?siteId=WH1&state=REQUESTED&trailerId=${tid}`)).json.items;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ reason: "FROM_DOOR", performer: "HOSTLER", from: { code: "WH1-DOCK-IN-01" } });
  });

  it("records a rejection and filters visits by state and plate", async () => {
    await call(stub, "POST", "/__stub/reset");
    const rej = await call(stub, "POST", `${Y}/visit-rejections`, { siteId: "WH1", carrier: "Acme", tractorPlate: "NOPE1", reason: "APPOINTMENT_REQUIRED" });
    expect(rej.status).toBe(201);
    expect(has(rej.json, REQUIRED.visit)).toBe(true);
    expect(rej.json).toMatchObject({ state: "REJECTED", rejectionReason: "APPOINTMENT_REQUIRED" });
    expect(problemSlug((await call(stub, "POST", `${Y}/visit-rejections`, { siteId: "WH1", carrier: "A", tractorPlate: "B", reason: "BAD" })).json)).toBe("validation");
    await checkIn({ tractorPlate: "OPEN1", purpose: "BOBTAIL" });
    expect((await call(stub, "GET", `${Y}/visits?siteId=WH1&state=REJECTED`)).json.items).toHaveLength(1);
    expect((await call(stub, "GET", `${Y}/visits?siteId=WH1&tractorPlate=OPEN1`)).json.items[0].state).toBe("CHECKED_IN");
  });

  it("rejects a seal mismatch at check-in when the policy says REJECT (and only then)", async () => {
    await call(stub, "POST", "/__stub/reset");
    const flagged = await checkIn({ tractorPlate: "S1", purpose: "LIVE_UNLOAD", appointmentId: "appt-stub-1", trailers: [trailerIn("SEAL-A", { sealNumber: "WRONG" })] });
    expect(flagged.json.visit.state).toBe("CHECKED_IN");
    await call(stub, "POST", "/__stub/reset");
    await call(stub, "POST", "/__stub/yard-policy", { sealMismatchAction: "REJECT" });
    const rejected = await checkIn({ tractorPlate: "S2", purpose: "LIVE_UNLOAD", appointmentId: "appt-stub-1", trailers: [trailerIn("SEAL-B", { sealNumber: "WRONG" })] });
    expect(rejected.status).toBe(201);
    expect(rejected.json).toMatchObject({ visit: { state: "REJECTED", rejectionReason: "SEAL_MISMATCH" }, trailers: [], moves: [] });
  });

  it("pages lists with limit and nextCursor", async () => {
    await call(stub, "POST", "/__stub/reset");
    await checkIn({ tractorPlate: "P1", purpose: "DROP", trailers: [trailerIn("PG-1"), trailerIn("PG-2")] });
    const one = await call(stub, "GET", `${Y}/trailers?siteId=WH1&limit=2`);
    expect(one.json.items).toHaveLength(2);
    expect(one.json.nextCursor).toBe("2");
    const two = await call(stub, "GET", `${Y}/trailers?siteId=WH1&limit=2&cursor=2`);
    expect(two.json.items).toHaveLength(1);
    expect(two.json.nextCursor).toBeUndefined();
  });

  it("answers unknown ids and routes with problem+json", async () => {
    for (const [method, path] of [["GET", `${Y}/visits/nope`], ["GET", `${Y}/trailers/nope`], ["GET", `${Y}/nothing`], ["POST", `${Y}/nothing`], ["POST", `${Y}/visits/nope/check-outs`], ["POST", `${Y}/moves/nope/completions`], ["POST", `${Y}/trailers/nope/door-work-starts`]] as const) {
      const r = await call(stub, method, path, method === "POST" ? {} : undefined);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.type).toContain("application/problem+json");
    }
    expect((await call(stub, "GET", `${Y}/moves?siteId=WH1`)).json.items[0]).toBeTruthy();
    expect(problemSlug((await call(stub, "POST", `${Y}/visits/nope/check-outs`, {})).json)).toBe("visit-not-found");
  });

  it("puts a move back in the queue when the lease lapses", async () => {
    const first = await call(shortLease, "POST", `${Y}/moves/claims`, { siteId: "WH1", hostlerRef: "host-1" });
    expect(first.status).toBe(201);
    await new Promise((r) => setTimeout(r, 450));
    const stolen = await call(shortLease, "POST", `${Y}/moves/claims`, { siteId: "WH1", hostlerRef: "host-2" });
    expect(stolen.json).toMatchObject({ moveId: first.json.moveId, hostlerRef: "host-2" });
    const late = await call(shortLease, "POST", `${Y}/moves/${first.json.moveId}/completions`, { hostlerRef: "host-1" });
    expect(problemSlug(late.json)).toBe("not-lease-holder");
  });
});
