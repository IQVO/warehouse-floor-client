import { describe, expect, it } from "vitest";
import { CommandRunner } from "../lib/commands";
import { Connectivity } from "../lib/connectivity";
import { Outbox } from "../lib/outbox";
import { MemoryStore } from "../lib/storage";
import { createFetchStub, jsonResponse } from "../test/fetchStub";
import { YB, checkIn, move, trailer, visit, yardProblem } from "../test/yardFixtures";
import { describeYardProblem, YARD_PROBLEM_CODES } from "./yardMessages";
import { yardManagementApi, yardReads, type YardManagementApi } from "./yardManagement";
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
  /** Every slug the OpenAPI names for the calls these screens make. */
  const SLUGS = [
    "appointment-required", "unknown-appointment", "visit-already-open", "trailer-already-on-site", "door-closed", "door-flow-mismatch", "no-free-spot",
    "invalid-carrier", "validation", "illegal-transition", "trailer-not-released", "seal-required", "trailer-on-hold", "trailer-has-open-move", "hostler-busy",
    "no-claimable-move", "not-lease-holder", "unexplained-destination", "location-occupied", "destination-reserved", "unknown-location", "trailer-not-found",
    "malformed-request-body", "precondition-failed", "dependency-unavailable",
  ];

  it("has operator wording for each, with no engineer text", () => {
    for (const slug of SLUGS) {
      expect(YARD_PROBLEM_CODES, slug).toContain(slug);
      const m = describeYardProblem({ type: `https://errors.yard-management.warehouse-systems.dev/${slug}`, title: "x", status: 409, detail: "usecases: raw" });
      expect(m.what.length).toBeGreaterThan(10);
      expect(m.todo.length).toBeGreaterThan(5);
      expect(`${m.what} ${m.todo}`).not.toMatch(/usecases|\{|409|422|slug/);
    }
  });

  it("falls back to the shared table for idempotency and gateway errors", () => {
    expect(describeYardProblem({ type: "about:blank", title: "Bad Gateway", status: 502 }).what).toMatch(/not answering/);
    expect(problemCode({ type: "https://x/idempotency-key-reused", title: "t", status: 409 })).toBe("idempotency-key-reused");
    expect(describeYardProblem({ type: "https://x/idempotency-key-reused", title: "t", status: 409 }).what).toMatch(/conflicts with an earlier/);
  });
});
