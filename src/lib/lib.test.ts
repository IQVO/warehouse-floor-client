import { describe, expect, it, vi } from "vitest";
import { Connectivity } from "./connectivity";
import { CommandRunner } from "./commands";
import { newIdempotencyKey } from "./idempotency";
import { log, sanitizeForLog } from "./log";
import { Outbox } from "./outbox";
import { parseProblem, problemCode } from "./problem";
import { MemoryStore } from "./storage";
import { createFetchStub, jsonResponse, noContent, problemResponse } from "../test/fetchStub";

const COMPLETE = "POST /api/fulfillment-execution/tasks/t-1/complete";

function setup(options: { online?: boolean } = {}) {
  const store = new MemoryStore();
  const outbox = new Outbox(store);
  const connectivity = new Connectivity(options.online ?? true);
  const fetchStub = createFetchStub();
  let n = 0;
  const runner = new CommandRunner({
    outbox,
    connectivity,
    fetchFn: () => fetchStub as unknown as typeof fetch,
    newKey: () => `key-${++n}`,
  });
  return { store, outbox, connectivity, fetchStub, runner };
}

const completeSpec = {
  kind: "complete",
  path: "/api/fulfillment-execution/tasks/t-1/complete",
  body: { stationId: "s-1" },
  dedupeId: "complete:t-1",
  meta: { taskId: "t-1" },
};

describe("newIdempotencyKey", () => {
  it("returns distinct RFC 4122 v4 UUIDs", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("still produces a v4 UUID where crypto.randomUUID is unavailable (plain-http RF guns)", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    try {
      expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("command runner: Idempotency-Key", () => {
  it("sends an Idempotency-Key on every command", async () => {
    const { runner, fetchStub } = setup();
    fetchStub.on(COMPLETE, noContent());
    await runner.submit(completeSpec);
    expect(fetchStub.calls[0]?.headers["idempotency-key"]).toBe("key-1");
  });

  it("reuses the SAME key when a network failure is retried by a replay", async () => {
    const { runner, fetchStub, outbox } = setup();
    fetchStub.on(COMPLETE, noContent());
    fetchStub.failNext(1);

    const first = await runner.submit(completeSpec);
    expect(first).toMatchObject({ state: "queued", key: "key-1", reason: "unreachable" });
    expect(outbox.list()).toHaveLength(1);

    await runner.flush();
    const keys = fetchStub.callsTo(COMPLETE).map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["key-1", "key-1"]);
    expect(outbox.list()).toHaveLength(0);
  });

  it("reuses the SAME key when the operator taps the same action again while it is pending", async () => {
    const { runner, fetchStub } = setup();
    fetchStub.on(COMPLETE, noContent());
    fetchStub.failNext(1);
    await runner.submit(completeSpec); // request lost: stored
    await runner.submit(completeSpec); // second tap: tries again
    const keys = fetchStub.callsTo(COMPLETE).map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["key-1", "key-1"]);
  });

  it("mints a NEW key for the same action once the first has a definitive answer", async () => {
    const { runner, fetchStub } = setup();
    fetchStub.on(COMPLETE, noContent());
    await runner.submit(completeSpec);
    await runner.submit(completeSpec);
    const keys = fetchStub.callsTo(COMPLETE).map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["key-1", "key-2"]);
  });

  it("mints a NEW key when the pending action's body changed (a reused key with another body is a 422)", async () => {
    const { runner, fetchStub, outbox } = setup();
    fetchStub.on(COMPLETE, noContent());
    fetchStub.failNext(1);
    await runner.submit({ ...completeSpec, body: { stationId: "s-1", quantity: 5 } });
    await runner.submit({ ...completeSpec, body: { stationId: "s-1", quantity: 6 } });
    const keys = fetchStub.callsTo(COMPLETE).map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["key-1", "key-2"]);
    expect(outbox.list()).toHaveLength(0);
  });

  it("gives a fire-and-forget command a fresh key per attempt and never queues it", async () => {
    const { runner, fetchStub, outbox } = setup();
    const spec = { kind: "renew-lease", path: "/api/fulfillment-execution/tasks/t-1/renew-lease", body: { stationId: "s-1" }, persist: false };
    fetchStub.on("POST /api/fulfillment-execution/tasks/t-1/renew-lease", noContent());
    await runner.submit(spec);
    fetchStub.failNext(1);
    const failed = await runner.submit(spec);
    expect(failed).toMatchObject({ state: "unsent", reason: "unreachable" });
    expect(outbox.list()).toHaveLength(0);
    const keys = fetchStub.calls.map((c) => c.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("command runner: persisted outbox", () => {
  it("writes the command to storage BEFORE the request leaves", async () => {
    const { runner, fetchStub, store } = setup();
    let seenDuringRequest = "";
    fetchStub.on(COMPLETE, () => {
      seenDuringRequest = store.getItem("wfc.outbox.v1") ?? "";
      return noContent();
    });
    await runner.submit(completeSpec);
    expect(seenDuringRequest).toContain('"key":"key-1"');
  });

  it("a reload mid-flight does not mint a new key: the next page load replays the stored one", async () => {
    const first = setup();
    first.fetchStub.on(COMPLETE, () => "network-error");
    await first.runner.submit(completeSpec); // page 1: request lost, command stored

    // "reload": brand-new Outbox/Runner/Connectivity over the same storage
    const outbox = new Outbox(first.store);
    const fetchStub = createFetchStub().on(COMPLETE, noContent());
    const settled = vi.fn();
    const runner = new CommandRunner({
      outbox,
      connectivity: new Connectivity(true),
      fetchFn: () => fetchStub as unknown as typeof fetch,
      newKey: () => "key-AFTER-RELOAD",
    });
    runner.onSettled(settled);
    await runner.flush();

    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]?.headers["idempotency-key"]).toBe("key-1");
    expect(fetchStub.calls[0]?.body).toEqual({ stationId: "s-1" });
    expect(settled).toHaveBeenCalledOnce();
    expect(outbox.list()).toHaveLength(0);
  });

  it("while offline queues without sending, then replays on reconnect with the SAME key", async () => {
    const { runner, fetchStub, connectivity, outbox } = setup({ online: false });
    fetchStub.on(COMPLETE, noContent());
    const settled = vi.fn();
    runner.onSettled(settled);

    const result = await runner.submit(completeSpec);
    expect(result).toMatchObject({ state: "queued", key: "key-1", reason: "offline" });
    expect(fetchStub.calls).toHaveLength(0);
    expect(outbox.list().map((e) => e.key)).toEqual(["key-1"]);

    connectivity.setBrowserOnline(true);
    await runner.flush();
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]?.headers["idempotency-key"]).toBe("key-1");
    expect(outbox.list()).toHaveLength(0);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ key: "key-1", kind: "complete" }), expect.objectContaining({ state: "done" }));
  });

  it("replays in FIFO order and stops at the first command that is still undeliverable", async () => {
    const { runner, fetchStub, outbox } = setup({ online: false });
    fetchStub.on("POST /api/a", noContent()).on("POST /api/b", noContent()).on("POST /api/c", noContent());
    await runner.submit({ kind: "a", path: "/api/a", dedupeId: "a" });
    await runner.submit({ kind: "b", path: "/api/b", dedupeId: "b" });
    await runner.submit({ kind: "c", path: "/api/c", dedupeId: "c" });

    // reachable again, but "b" gets a 503 from the edge
    const online = new Connectivity(true);
    const replay = new CommandRunner({
      outbox,
      connectivity: online,
      fetchFn: () => fetchStub as unknown as typeof fetch,
    });
    fetchStub.on("POST /api/b", () => new Response("upstream down", { status: 503 }));
    await replay.flush();
    expect(fetchStub.calls.map((c) => c.url)).toEqual(["/api/a", "/api/b"]);
    expect(outbox.list().map((e) => e.kind)).toEqual(["b", "c"]);

    fetchStub.on("POST /api/b", noContent());
    await replay.flush();
    expect(fetchStub.calls.map((c) => c.url)).toEqual(["/api/a", "/api/b", "/api/b", "/api/c"]);
    expect(outbox.list()).toHaveLength(0);
  });

  it("treats a 4xx problem as a definitive answer: removed from the outbox, reported, never retried", async () => {
    const { runner, fetchStub, outbox } = setup();
    fetchStub.on(COMPLETE, problemResponse(409, "task-already-completed", "Task already completed"));
    const result = await runner.submit(completeSpec);
    expect(result).toMatchObject({ state: "problem", status: 409 });
    expect(outbox.list()).toHaveLength(0);
    await runner.flush();
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("keeps the command on a gateway 502/503/504/429 and retries later with the same key", async () => {
    const { runner, fetchStub, outbox } = setup();
    fetchStub.on(COMPLETE, () => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await runner.submit(completeSpec)).toMatchObject({ state: "queued", reason: "unavailable" });
    expect(outbox.list()).toHaveLength(1);
    fetchStub.on(COMPLETE, noContent());
    await runner.flush();
    expect(fetchStub.calls.map((c) => c.headers["idempotency-key"])).toEqual(["key-1", "key-1"]);
  });

  it("parses a 2xx JSON body and the server Date", async () => {
    const { runner, fetchStub } = setup();
    fetchStub.on("POST /api/x", jsonResponse(200, { id: "t" }, { Date: "Mon, 19 Oct 2026 12:00:00 GMT" }));
    const result = await runner.submit({ kind: "x", path: "/api/x" });
    expect(result).toMatchObject({ state: "done", data: { id: "t" }, serverTime: Date.UTC(2026, 9, 19, 12) });
  });
});

describe("Outbox", () => {
  it("ignores corrupt storage and entries that are not same-origin /api/ commands", () => {
    const store = new MemoryStore();
    store.setItem("wfc.outbox.v1", "{not json");
    expect(new Outbox(store).list()).toEqual([]);
    store.setItem(
      "wfc.outbox.v1",
      JSON.stringify([
        { key: "k", kind: "x", method: "POST", path: "https://evil.example/steal", createdAt: 1, attempts: 0, meta: {} },
        { key: "k2", kind: "x", method: "POST", path: "/api/ok", createdAt: 1, attempts: 0, meta: {} },
      ]),
    );
    expect(new Outbox(store).list().map((e) => e.key)).toEqual(["k2"]);
  });
});

describe("problem details", () => {
  it("reads problem+json and derives the code from the type URI", () => {
    const p = parseProblem(409, "Conflict", JSON.stringify({ type: "https://e.example/no-claimable-task", title: "No claimable task", status: 409, detail: "d" }));
    expect(p).toMatchObject({ title: "No claimable task", status: 409 });
    expect(problemCode(p)).toBe("no-claimable-task");
  });

  it("turns an HTML gateway page into an about:blank problem instead of throwing", () => {
    const p = parseProblem(502, "Bad Gateway", "<html>nope</html>");
    expect(p).toEqual({ type: "about:blank", title: "Bad Gateway", status: 502 });
  });
});

describe("log-injection guard", () => {
  it("flattens CR/LF and other control characters in request-derived values", () => {
    expect(sanitizeForLog("abc\r\n[floor] forged line\u2028x")).toBe("abc [floor] forged line x");
    expect(sanitizeForLog("a\u0000b\u001b[31mred")).toBe("a b [31mred");
  });

  it("emits exactly one line per call, whatever the values contain", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      log.warn("request failed", "station-1\r\nERROR forged", { path: "/x\ny" });
      expect(spy).toHaveBeenCalledOnce();
      const line = String(spy.mock.calls[0]?.[0]);
      expect(line).not.toMatch(/[\r\n]/);
      expect(line).toContain("station-1 ERROR forged");
    } finally {
      spy.mockRestore();
    }
  });

  it("truncates very long values", () => {
    expect(sanitizeForLog("x".repeat(1000)).length).toBeLessThan(210);
  });
});
