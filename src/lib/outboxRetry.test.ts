import { describe, expect, it } from "vitest";
import { Connectivity } from "./connectivity";
import { CommandRunner } from "./commands";
import { Outbox, type OutboxEntry } from "./outbox";
import { MemoryStore } from "./storage";
import { createFetchStub, noContent } from "../test/fetchStub";

const COMPLETE = "POST /api/fulfillment-execution/tasks/t-1/completions";

const completeSpec = {
  kind: "complete",
  path: "/api/fulfillment-execution/tasks/t-1/completions",
  body: { stationId: "s-1" },
  dedupeId: "complete:t-1",
  meta: { taskId: "t-1" },
};

function setup(options: { online?: boolean; maxAttempts?: number } = {}) {
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
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
  return { store, outbox, connectivity, fetchStub, runner };
}

/** A fetch that hangs until the runner aborts it: the request left, no answer ever came back. */
function abortingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    void input;
  });
}

describe("command runner: retryable 5xx and aborts", () => {
  it("keeps the command on a 500 and retries later with the same key", async () => {
    const { runner, fetchStub, outbox } = setup();
    fetchStub.on(COMPLETE, () => new Response("upstream exploded", { status: 500 }));
    const result = await runner.submit(completeSpec);
    expect(result).toMatchObject({ state: "queued", key: "key-1", reason: "unavailable" });
    expect(outbox.list()).toHaveLength(1);

    fetchStub.on(COMPLETE, noContent());
    await runner.flush();
    const keys = fetchStub.callsTo(COMPLETE).map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["key-1", "key-1"]);
    expect(outbox.list()).toHaveLength(0);
  });

  it("treats an abort after the request left as retryable, not as a definitive answer", async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store);
    const runner = new CommandRunner({
      outbox,
      connectivity: new Connectivity(true),
      fetchFn: () => abortingFetch as unknown as typeof fetch,
      newKey: () => "key-abort",
      requestTimeoutMs: 10,
    });
    const result = await runner.submit(completeSpec);
    expect(result).toMatchObject({ state: "queued", key: "key-abort", reason: "unreachable" });
    expect(outbox.list().map((e) => e.key)).toEqual(["key-abort"]);
  });
});

describe("command runner: per-entry attempt cap", () => {
  it("marks the entry stuck once the cap is hit and stops transmitting it", async () => {
    const { runner, fetchStub, outbox } = setup({ maxAttempts: 2 });
    fetchStub.on(COMPLETE, () => new Response("down", { status: 503 }));

    await runner.submit(completeSpec); // attempt 1: below the cap, still auto-retryable
    expect(outbox.list()[0]).toMatchObject({ attempts: 1 });
    expect(outbox.list()[0]?.stuck).toBeUndefined();

    await runner.flush(); // attempt 2: cap hit
    expect(outbox.list()[0]).toMatchObject({ key: "key-1", attempts: 2, stuck: true });

    await runner.flush(); // stuck: no further attempts
    await runner.flush();
    expect(fetchStub.callsTo(COMPLETE)).toHaveLength(2);
    expect(outbox.list()).toHaveLength(1);
  });

  it("a stuck entry stops blocking the queue behind it", async () => {
    const { runner, fetchStub, outbox } = setup({ online: false, maxAttempts: 1 });
    fetchStub.on("POST /api/a", () => new Response("down", { status: 503 }));
    fetchStub.on("POST /api/b", noContent());
    await runner.submit({ kind: "a", path: "/api/a", dedupeId: "a" });
    await runner.submit({ kind: "b", path: "/api/b", dedupeId: "b" });
    expect(fetchStub.calls).toHaveLength(0);

    await runner.flush(); // "a" hits its cap on the first attempt and stops the pass
    expect(outbox.list().map((e) => [e.kind, e.stuck])).toEqual([["a", true], ["b", undefined]]);
    await runner.flush(); // "a" is skipped as stuck; "b" goes through
    expect(fetchStub.calls.map((c) => c.url)).toEqual(["/api/a", "/api/b"]);
    expect(outbox.list().map((e) => e.kind)).toEqual(["a"]);
  });

  it("a re-tap of a stuck action reuses the SAME key with a fresh round of attempts", async () => {
    const { runner, fetchStub, outbox } = setup({ maxAttempts: 1 });
    fetchStub.on(COMPLETE, () => new Response("down", { status: 503 }));
    await runner.submit(completeSpec);
    expect(outbox.list()[0]).toMatchObject({ stuck: true });

    fetchStub.on(COMPLETE, noContent());
    const result = await runner.submit(completeSpec);
    expect(result).toMatchObject({ state: "done" });
    const keys = fetchStub.callsTo(COMPLETE).map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["key-1", "key-1"]);
    expect(outbox.list()).toHaveLength(0);
  });

  it("Outbox.retry clears the stuck flag and resets attempts for the next round", () => {
    const outbox = new Outbox(new MemoryStore());
    const entry: OutboxEntry = {
      key: "k", kind: "complete", method: "POST", path: "/api/x", meta: {},
      createdAt: 1, attempts: 8, stuck: true,
    };
    outbox.put(entry);
    outbox.retry("k");
    expect(outbox.get("k")).toMatchObject({ attempts: 0, stuck: undefined });
    outbox.remove("k");
    expect(outbox.list()).toHaveLength(0);
  });
});
