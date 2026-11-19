import { describe, expect, it, vi } from "vitest";
import { CommandRunner, type Outcome } from "./commands";
import { Connectivity } from "./connectivity";
import { Outbox, type OutboxEntry } from "./outbox";
import { MemoryStore } from "./storage";
import { createFetchStub, noContent, problemResponse } from "../test/fetchStub";

const PATH = "/api/fulfillment-execution/tasks/t-1/completions";
const spec = { kind: "complete", path: PATH, body: { stationId: "s-1" }, dedupeId: "complete:t-1", meta: { taskId: "t-1" } };

/** A command queued by a lost connection, then a runner whose replay gets `answer`. */
async function queuedThenAnswered(answer: Response) {
  const fetchStub = createFetchStub().on(`POST ${PATH}`, "network-error");
  const outbox = new Outbox(new MemoryStore());
  const runner = new CommandRunner({ outbox, connectivity: new Connectivity(true), fetchFn: () => fetchStub as unknown as typeof fetch, newKey: () => "k-1", retryIntervalMs: 3_600_000 });
  expect(await runner.submit(spec)).toMatchObject({ state: "queued" });
  fetchStub.on(`POST ${PATH}`, answer);
  return { runner, outbox, fetchStub };
}

/**
 * The rule the screens rely on: an answer that arrives on a replay is presented by whoever says it handled it,
 * and by the fallback listeners when nobody did. Never by both, never by neither.
 */
describe("command runner: who presents a replayed answer", () => {
  it("nobody handled it: the fallback listener hears the entry and its answer, once", async () => {
    const { runner, outbox } = await queuedThenAnswered(problemResponse(409, "task-not-claimed", "Task is not claimed"));
    const fallback = vi.fn<(entry: OutboxEntry, outcome: Outcome) => void>();
    runner.onUnhandledSettled(fallback);
    runner.onSettled(() => false);
    runner.onSettled(() => undefined);
    await runner.flush();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0]?.[0]).toMatchObject({ key: "k-1", kind: "complete", meta: { taskId: "t-1" } });
    expect(fallback.mock.calls[0]?.[1]).toMatchObject({ state: "problem", status: 409 });
    expect(outbox.list()).toHaveLength(0);
    await runner.flush();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("a listener handled it: every listener still hears it, the fallback does not", async () => {
    const { runner } = await queuedThenAnswered(problemResponse(409, "task-not-claimed", "Task is not claimed"));
    const fallback = vi.fn();
    const first = vi.fn(() => true);
    const second = vi.fn(() => false);
    runner.onUnhandledSettled(fallback);
    runner.onSettled(first);
    runner.onSettled(second);
    await runner.flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("a success nobody handled reaches the fallback too, and an unsubscribed fallback hears nothing", async () => {
    const { runner } = await queuedThenAnswered(noContent());
    const fallback = vi.fn();
    const gone = vi.fn();
    runner.onUnhandledSettled(fallback);
    runner.onUnhandledSettled(gone)();
    await runner.flush();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0]?.[1]).toMatchObject({ state: "done", status: 204 });
    expect(gone).not.toHaveBeenCalled();
  });

  it("an answer the caller awaited directly goes to the caller only", async () => {
    const fetchStub = createFetchStub().on(`POST ${PATH}`, problemResponse(409, "task-not-claimed", "Task is not claimed"));
    const runner = new CommandRunner({ outbox: new Outbox(new MemoryStore()), connectivity: new Connectivity(true), fetchFn: () => fetchStub as unknown as typeof fetch, retryIntervalMs: 3_600_000 });
    const fallback = vi.fn();
    const listener = vi.fn();
    runner.onUnhandledSettled(fallback);
    runner.onSettled(listener);
    expect(await runner.submit(spec)).toMatchObject({ state: "problem" });
    expect(fallback).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
