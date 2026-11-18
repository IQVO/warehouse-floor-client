import { describe, expect, it } from "vitest";
import { CommandRunner } from "../lib/commands";
import { Connectivity } from "../lib/connectivity";
import { Outbox, type OutboxEntry } from "../lib/outbox";
import { MemoryStore } from "../lib/storage";
import { createFetchStub, jsonResponse } from "../test/fetchStub";
import { YB, checkIn, move, trailer, visit, yardProblem } from "../test/yardFixtures";
import { describeYardProblem, YARD_PROBLEM_CODES } from "./yardMessages";
import { SEAL_CLASSES, yardManagementApi, yardReads, type CheckInRequest, type YardManagementApi } from "./yardManagement";
import { problemCode } from "../lib/problem";

function runnerOn(store: MemoryStore, fetchStub: unknown, prefix: string) {
  let n = 0;
  return new CommandRunner({
    outbox: new Outbox(store),
    connectivity: new Connectivity(true),
    fetchFn: () => fetchStub as unknown as typeof fetch,
    newKey: () => `${prefix}-${++n}`,
    retryIntervalMs: 3_600_000,
  });
}

/** Every yard command: how to issue it, where it goes, what it answers. */
const COMMANDS: { name: string; key: string; call: (api: YardManagementApi) => Promise<unknown>; answer: unknown; body: unknown }[] = [
  {
    name: "check in a visit",
    key: `POST ${YB}/visits`,
    call: (a) => a.checkInVisit({ siteId: "WH1", carrier: "Acme", tractorPlate: "ABC1234", purpose: "BOBTAIL" }),
    answer: checkIn(),
    body: { siteId: "WH1", carrier: "Acme", tractorPlate: "ABC1234", purpose: "BOBTAIL" },
  },
  {
    name: "reject at the gate",
    key: `POST ${YB}/visit-rejections`,
    call: (a) => a.rejectAtGate({ siteId: "WH1", carrier: "Acme", tractorPlate: "ABC1234", reason: "SITE_REQUEST" }),
    answer: visit({ state: "REJECTED" }),
    body: { siteId: "WH1", carrier: "Acme", tractorPlate: "ABC1234", reason: "SITE_REQUEST" },
  },
  {
    name: "check a visit out",
    key: `POST ${YB}/visits/visit-1/check-outs`,
    call: (a) => a.checkOutVisit("visit-1", ["trl-1", "trl-2"]),
    answer: visit({ state: "CHECKED_OUT" }),
    body: { trailersOut: [{ trailerId: "trl-1" }, { trailerId: "trl-2" }] },
  },
  {
    name: "claim the next move",
    key: `POST ${YB}/moves/claims`,
    call: (a) => a.claimNextMove("WH1", "host-1"),
    answer: move({ performer: "HOSTLER" }),
    body: { siteId: "WH1", hostlerRef: "host-1" },
  },
  {
    name: "complete a move",
    key: `POST ${YB}/moves/mv-1/completions`,
    call: (a) => a.completeMove("mv-1", { hostlerRef: "host-1", actualLocation: { kind: "SPOT", code: "WH1-YARD-02" } }),
    answer: move({ state: "COMPLETED" }),
    body: { hostlerRef: "host-1", actualLocation: { kind: "SPOT", code: "WH1-YARD-02" } },
  },
  {
    name: "start door work",
    key: `POST ${YB}/trailers/trl-1/door-work-starts`,
    call: (a) => a.startDoorWork("trl-1"),
    answer: trailer({ doorWork: "IN_PROGRESS" }),
    body: undefined,
  },
  {
    name: "complete door work",
    key: `POST ${YB}/trailers/trl-1/door-work-completions`,
    call: (a) => a.completeDoorWork("trl-1", "EMPTY"),
    answer: trailer({ doorWork: "DONE" }),
    body: { loadState: "EMPTY" },
  },
];

describe.each(COMMANDS)("yard command: $name", ({ key, call, answer, body }) => {
  it("goes to same-origin /api/yard-management with an Idempotency-Key and the documented body", async () => {
    const store = new MemoryStore();
    const stub = createFetchStub().on(key, jsonResponse(200, answer));
    expect(await call(yardManagementApi(runnerOn(store, stub, "k")))).toMatchObject({ state: "done" });
    const [sent] = stub.calls;
    expect(sent?.url.startsWith(`${YB}/`)).toBe(true);
    expect(sent?.headers["idempotency-key"]).toBe("k-1");
    expect(sent?.body).toEqual(body);
  });

  it("reuses the key on a second tap while nothing was answered, and across a reload", async () => {
    const store = new MemoryStore();
    const stub = createFetchStub().on(key, "network-error");
    const first = await call(yardManagementApi(runnerOn(store, stub, "a")));
    expect(first).toMatchObject({ state: "queued", key: "a-1" });

    // Same action again (the operator taps again): same key, one outbox entry.
    expect(await call(yardManagementApi(runnerOn(store, stub, "b")))).toMatchObject({ state: "queued", key: "a-1" });
    expect(new Outbox(store).list()).toHaveLength(1);

    // The page reloads: a brand new runner finds the entry and replays it with its original key.
    stub.on(key, jsonResponse(200, answer));
    await runnerOn(store, stub, "c").flush();
    const keys = stub.callsTo(key).map((c) => c.headers["idempotency-key"]);
    expect(keys.every((k) => k === "a-1")).toBe(true);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(new Outbox(store).list()).toHaveLength(0);
  });
});

describe("yard commands: a changed body is a different action", () => {
  it("mints a new key when the same move is completed at a different place", async () => {
    const store = new MemoryStore();
    const stub = createFetchStub().on(`POST ${YB}/moves/mv-1/completions`, "network-error");
    const api = yardManagementApi(runnerOn(store, stub, "k"));
    expect(await api.completeMove("mv-1", { hostlerRef: "h", actualLocation: { kind: "SPOT", code: "A" } })).toMatchObject({ key: "k-1" });
    expect(await api.completeMove("mv-1", { hostlerRef: "h", actualLocation: { kind: "SPOT", code: "B" } })).toMatchObject({ key: "k-2" });
  });

  it("encodes ids placed in a path", async () => {
    const stub = createFetchStub().on(`POST ${YB}/trailers/a%2Fb/door-work-starts`, jsonResponse(200, trailer()));
    const api = yardManagementApi(runnerOn(new MemoryStore(), stub, "k"));
    expect(await api.startDoorWork("a/b")).toMatchObject({ state: "done" });
  });
});

// yard-management ADR 0012, OpenAPI TrailerIn.sealClass: "type: string, enum: [I, S, H] ... Optional ISO 17712 class
// of the seal ...; needs a sealNumber". The body is stored in the outbox as it was built and replayed as stored.
describe("check-in seal class: the request and the offline outbox", () => {
  const VISITS = `POST ${YB}/visits`;
  const visitOf = (trailer: NonNullable<CheckInRequest["trailers"]>[number]): CheckInRequest => ({ siteId: "WH1", carrier: "Acme", tractorPlate: "ABC1234", purpose: "DROP", trailers: [trailer] });
  const WITH_CLASS = visitOf({ unitNumber: "TRL-1", kind: "DRY_VAN", loadState: "LOADED", sealNumber: "S-100", sealClass: "H" });
  const NO_CLASS = visitOf({ unitNumber: "TRL-1", kind: "DRY_VAN", loadState: "LOADED", sealNumber: "S-100" });
  const NO_SEAL = visitOf({ unitNumber: "TRL-1", kind: "DRY_VAN", loadState: "EMPTY" });
  const STORE_KEY = "wfc.outbox.v1";

  it("knows the three classes of the OpenAPI enum, weakest first", () => {
    expect(SEAL_CLASSES).toEqual(["I", "S", "H"]);
  });

  it("sends trailers[].sealClass when it is stated", async () => {
    const stub = createFetchStub().on(VISITS, jsonResponse(201, checkIn()));
    await yardManagementApi(runnerOn(new MemoryStore(), stub, "k")).checkInVisit(WITH_CLASS);
    expect(stub.calls[0]?.body).toEqual(WITH_CLASS);
    expect(stub.calls[0]?.body).toMatchObject({ trailers: [{ sealNumber: "S-100", sealClass: "H" }] });
  });

  it.each([
    ["a seal with no class stated", NO_CLASS],
    ["no seal", NO_SEAL],
  ])("leaves the property out for %s (no empty string, no null)", async (_name, body) => {
    const stub = createFetchStub().on(VISITS, jsonResponse(201, checkIn()));
    await yardManagementApi(runnerOn(new MemoryStore(), stub, "k")).checkInVisit(body);
    expect(stub.calls[0]?.body).toEqual(body);
    expect(JSON.stringify(stub.calls[0]?.body)).not.toContain("sealClass");
  });

  it.each([
    ["with a seal class", WITH_CLASS],
    ["without one", NO_CLASS],
  ])("a queued check-in %s is stored whole, survives a reload and replays the same body with the same key", async (_name, body) => {
    const store = new MemoryStore();
    const stub = createFetchStub().on(VISITS, "network-error");
    expect(await yardManagementApi(runnerOn(store, stub, "a")).checkInVisit(body)).toMatchObject({ state: "queued", key: "a-1" });

    // What is on the device is the request itself.
    const stored = JSON.parse(store.getItem(STORE_KEY) ?? "[]") as OutboxEntry[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ key: "a-1", kind: "yard-check-in", method: "POST", path: `${YB}/visits`, body, dedupeId: "yard-check-in:WH1:ABC1234" });

    // Reload: a new outbox and a new runner read the store.
    stub.on(VISITS, jsonResponse(201, checkIn()));
    await runnerOn(store, stub, "b").flush();
    const replay = stub.callsTo(VISITS).at(-1);
    expect(replay?.headers["idempotency-key"]).toBe("a-1");
    expect(replay?.body).toEqual(body);
    expect(JSON.stringify(replay?.body).includes("sealClass")).toBe(body === WITH_CLASS);
    expect(new Outbox(store).list()).toHaveLength(0);
  });

  it("a check-in queued by a build that did not know sealClass still loads and replays untouched", async () => {
    // Exactly what the previous build wrote: same storage key, same entry shape, a trailer with a seal number only.
    const old = { key: "old-build-key", kind: "yard-check-in", method: "POST", path: `${YB}/visits`, body: NO_CLASS, dedupeId: "yard-check-in:WH1:ABC1234", meta: { siteId: "WH1", tractorPlate: "ABC1234" }, createdAt: 1_794_000_000_000, attempts: 3 };
    const raw = JSON.stringify([old]);
    const store = new MemoryStore();
    store.setItem(STORE_KEY, raw);

    const outbox = new Outbox(store);
    expect(outbox.list()).toEqual([old]);
    expect(store.getItem(STORE_KEY)).toBe(raw); // nothing to migrate: the field is optional, the stored shape is unchanged

    const stub = createFetchStub().on(VISITS, jsonResponse(201, checkIn()));
    await runnerOn(store, stub, "must-not-be-used").flush();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.headers["idempotency-key"]).toBe("old-build-key");
    expect(stub.calls[0]?.body).toEqual(NO_CLASS);
    expect(JSON.stringify(stub.calls[0]?.body)).not.toContain("sealClass");
    expect(new Outbox(store).list()).toHaveLength(0);
  });

  it("the same truck sent again with the class now stated is a different request: a new key, one entry", async () => {
    const store = new MemoryStore();
    const stub = createFetchStub().on(VISITS, "network-error");
    const api = yardManagementApi(runnerOn(store, stub, "k"));
    expect(await api.checkInVisit(NO_CLASS)).toMatchObject({ key: "k-1" });
    expect(await api.checkInVisit(WITH_CLASS)).toMatchObject({ key: "k-2" });
    expect(new Outbox(store).list().map((e) => e.key)).toEqual(["k-2"]);
  });
});

// yard-management ADR 0016: the 409 `carrier-suspended` comes AFTER the REJECTED visit is recorded, so a retry
// of any kind would record a second turn-away. Every 4xx is a definitive answer for the runner.
describe("a queued check-in answered 409 carrier-suspended on replay", () => {
  it("ends with that answer: the entry leaves the outbox, the listener hears it once, and nothing is sent again", async () => {
    const VISITS = `POST ${YB}/visits`;
    const store = new MemoryStore();
    const stub = createFetchStub().on(VISITS, "network-error");
    const body: CheckInRequest = { siteId: "WH1", carrier: "Acme", carrierScac: "ACME", tractorPlate: "ABC1234", purpose: "BOBTAIL" };
    expect(await yardManagementApi(runnerOn(store, stub, "a")).checkInVisit(body)).toMatchObject({ state: "queued", key: "a-1" });

    stub.on(VISITS, yardProblem(409, "carrier-suspended", "The carrier is suspended"));
    const runner = runnerOn(store, stub, "b");
    const heard: { kind: string; plate: string | undefined; state: string; slug: string }[] = [];
    runner.onSettled((entry, outcome) => {
      heard.push({ kind: entry.kind, plate: entry.meta.tractorPlate, state: outcome.state, slug: outcome.state === "problem" ? problemCode(outcome.problem) : "" });
    });
    await runner.flush();

    expect(heard).toEqual([{ kind: "yard-check-in", plate: "ABC1234", state: "problem", slug: "carrier-suspended" }]);
    expect(new Outbox(store).list()).toHaveLength(0);
    const sentSoFar = stub.callsTo(VISITS).length;
    await runner.flush();
    await runnerOn(store, stub, "c").flush();
    expect(stub.callsTo(VISITS)).toHaveLength(sentSoFar);
    expect(stub.callsTo(VISITS).every((c) => c.headers["idempotency-key"] === "a-1")).toBe(true);
    expect(heard).toHaveLength(1);
  });
});

describe("yardReads", () => {
  it("follows nextCursor, sends limit 500 and drops empty filters", async () => {
    const stub = createFetchStub()
      .on(`GET ${YB}/trailers?siteId=WH1&state=DOCKED&limit=500`, jsonResponse(200, { items: [trailer({ trailerId: "t1" })], nextCursor: "c/1" }))
      .on(`GET ${YB}/trailers?siteId=WH1&state=DOCKED&limit=500&cursor=c%2F1`, jsonResponse(200, { items: [trailer({ trailerId: "t2" })], nextCursor: null }));
    const r = await yardReads.listTrailers({ siteId: "WH1", state: "DOCKED", unitNumber: "" }, stub as unknown as typeof fetch);
    expect(r).toMatchObject({ state: "done" });
    if (r.state === "done") expect(r.data.map((t) => t.trailerId)).toEqual(["t1", "t2"]);
  });

  it("stops at the page bound when a server never ends the list", async () => {
    const stub = createFetchStub();
    stub.on(`GET ${YB}/moves?siteId=WH1&limit=500`, jsonResponse(200, { items: [], nextCursor: "again" }));
    for (let i = 0; i < 12; i++) stub.on(`GET ${YB}/moves?siteId=WH1&limit=500&cursor=again`, jsonResponse(200, { items: [move()], nextCursor: "again" }));
    const r = await yardReads.listMoves({ siteId: "WH1" }, stub as unknown as typeof fetch);
    expect(r.state).toBe("done");
    expect(stub.calls.length).toBe(10);
  });

  it("reports a problem and an unreachable server without throwing", async () => {
    const stub = createFetchStub().on(`GET ${YB}/visits/v-9`, yardProblem(404, "visit-not-found", "Visit not found"));
    expect(await yardReads.getVisit("v-9", stub as unknown as typeof fetch)).toMatchObject({ state: "problem" });
    stub.failNext();
    expect(await yardReads.listVisits({ siteId: "WH1" }, stub as unknown as typeof fetch)).toEqual({ state: "unreachable" });
  });
});

describe("yard problem copy", () => {
  /**
   * Every slug yard-management's OpenAPI (origin/develop) names for the calls these screens make. A slug the
   * service adds to one of those calls goes here first: this list failing is how a missing copy is caught.
   * `invalid-seal-class` is here because the check-in form sends `sealClass`. Left out on purpose:
   * `invalid-hazmat-class` and `invalid-un-number`. POST /visits answers them only for `hazmatClass` and
   * `unNumber`, which this client never sends.
   */
  const SLUGS = [
    "appointment-required", "unknown-appointment", "visit-already-open", "trailer-already-on-site", "door-closed", "door-flow-mismatch", "no-free-spot",
    "invalid-carrier", "validation", "illegal-transition", "trailer-not-released", "seal-required", "trailer-on-hold", "trailer-has-open-move", "hostler-busy",
    "no-claimable-move", "not-lease-holder", "unexplained-destination", "location-occupied", "destination-reserved", "unknown-location", "trailer-not-found",
    "visit-not-found", "move-not-found", "malformed-request-body", "precondition-failed", "dependency-unavailable",
    // yard-management ADR 0012 to 0016: identifiers at the gate, dock safety, placement, inspections, suspended carriers.
    "carrier-suspended", "seal-class-too-low", "invalid-seal-class", "invalid-unit-number", "placement-rule-violated", "trailer-still-secured",
    "trailer-not-secured", "inspection-required", "inspection-failed",
  ];
  const yardSlug = (slug: string, status = 409) => ({ type: `https://errors.yard-management.warehouse-systems.dev/${slug}`, title: "Service title", status, detail: "usecases: raw" });
  /** What a slug with no copy gets: the service title plus "Try again. If it keeps happening, call your lead." */
  const GENERIC_TODO = describeYardProblem(yardSlug("a-slug-this-build-does-not-know")).todo;

  it("has operator wording for each, with no engineer text", () => {
    for (const slug of SLUGS) {
      expect(YARD_PROBLEM_CODES, slug).toContain(slug);
      const m = describeYardProblem({ type: `https://errors.yard-management.warehouse-systems.dev/${slug}`, title: "x", status: 409, detail: "usecases: raw" });
      expect(m.what.length).toBeGreaterThan(10);
      expect(m.todo.length).toBeGreaterThan(5);
      expect(`${m.what} ${m.todo}`).not.toMatch(/usecases|\{|409|422|slug/);
    }
  });

  it.each<[string, number, RegExp, RegExp]>([
    ["carrier-suspended", 409, /turned away/i, /does not enter/i],
    ["seal-class-too-low", 409, /seal/i, /your lead/i],
    ["invalid-seal-class", 422, /seal strength/i, /choose the seal strength again/i],
    ["invalid-unit-number", 422, /container number/i, /enter it again/i],
    ["placement-rule-violated", 409, /dangerous goods/i, /spot set aside/i],
    ["trailer-still-secured", 409, /still secured/i, /released/i],
    ["trailer-not-secured", 409, /secured/i, /secure the trailer/i],
    ["inspection-required", 409, /inspection/i, /your lead/i],
    ["inspection-failed", 409, /inspection failed/i, /your lead/i],
  ])("%s (%i) says what happened and what to do, not the generic fallback", (slug, status, what, todo) => {
    const m = describeYardProblem(yardSlug(slug, status));
    expect(m.what).toMatch(what);
    expect(m.todo).toMatch(todo);
    expect(m.what).not.toContain("Service title");
    expect(m.todo).not.toBe(GENERIC_TODO);
    expect(`${m.what} ${m.todo}`).not.toMatch(/usecases|\{|409|422|slug|policy|hazmat|\bISO\b/i);
  });

  it("carrier-suspended: the truck is turned away, the turn-away is on record, and nothing asks for a retry", () => {
    const m = describeYardProblem(yardSlug("carrier-suspended"));
    expect(m.what).toMatch(/turned away/i);
    expect(m.what).toMatch(/recorded/i);
    expect(m.todo).toMatch(/does not enter/i);
    expect(`${m.what} ${m.todo}`).not.toMatch(/try again|retry|in a moment/i);
  });

  it("seal-class-too-low: the clerk can fix it here by stating the strength, and is not told to just try again", () => {
    const m = describeYardProblem(yardSlug("seal-class-too-low"));
    expect(m.what).toMatch(/weaker|not stated/i);
    expect(m.todo).toMatch(/choose (it|the seal strength)/i);
    expect(m.todo).toMatch(/check in again/i);
    expect(`${m.what} ${m.todo}`).not.toMatch(/class [ISH]\b|17712/);
  });

  it("the two slugs the form cannot trigger stay on the fallback", () => {
    for (const slug of ["invalid-hazmat-class", "invalid-un-number"]) expect(YARD_PROBLEM_CODES, slug).not.toContain(slug);
  });

  it("keeps the generic fallback for a slug this build does not know", () => {
    expect(GENERIC_TODO).toBe("Try again. If it keeps happening, call your lead.");
    expect(describeYardProblem(yardSlug("a-slug-this-build-does-not-know")).what).toBe("Service title.");
  });

  it("falls back to the shared table for idempotency and gateway errors", () => {
    expect(describeYardProblem({ type: "about:blank", title: "Bad Gateway", status: 502 }).what).toMatch(/not answering/);
    expect(problemCode({ type: "https://x/idempotency-key-reused", title: "t", status: 409 })).toBe("idempotency-key-reused");
    expect(describeYardProblem({ type: "https://x/idempotency-key-reused", title: "t", status: 409 }).what).toMatch(/conflicts with an earlier/);
  });
});
