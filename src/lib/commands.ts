import type { Connectivity } from "./connectivity";
import { newIdempotencyKey } from "./idempotency";
import { log } from "./log";
import type { Outbox, OutboxEntry } from "./outbox";
import { parseProblem, type Problem } from "./problem";

/** What a screen asks for. The runner turns it into an outbox entry + a request. */
export interface CommandSpec {
  kind: string;
  method?: "POST" | "PUT";
  /** Same-origin path through Kong: /api/<context>/... */
  path: string;
  body?: unknown;
  /** Same logical action => same key while it is pending (and its body is unchanged). */
  dedupeId?: string;
  meta?: Record<string, string>;
  /**
   * false: a fire-and-forget command (lease renewal). It still carries a fresh
   * Idempotency-Key, but is never queued: a replay hours later would be noise.
   */
  persist?: boolean;
}

export type RetryReason = "offline" | "unreachable" | "unavailable";

export type Outcome<T = unknown> =
  /** 2xx. `data` is the parsed JSON body (undefined for 204). `serverTime` is the response Date, epoch ms. */
  | { state: "done"; status: number; data: T | undefined; serverTime: number | undefined }
  /** A definitive 4xx/5xx with problem details. Nothing was applied (or the key's stored answer was replayed). */
  | { state: "problem"; status: number; problem: Problem }
  /** No answer yet; saved in the outbox and will be replayed with the SAME key. */
  | { state: "queued"; key: string; reason: RetryReason }
  /** No answer, and (persist:false) not saved either. */
  | { state: "unsent"; reason: RetryReason };

export type SettledListener = (entry: OutboxEntry, outcome: Outcome) => void;

export interface RunnerOptions {
  outbox: Outbox;
  connectivity: Connectivity;
  /** Looked up per request so a test (or the browser) can swap fetch after construction. */
  fetchFn?: () => typeof fetch;
  newKey?: () => string;
  now?: () => number;
  requestTimeoutMs?: number;
  /** How often to retry while the outbox is non-empty. */
  retryIntervalMs?: number;
}

/** Gateway-level "try again" statuses. Everything else is a definitive answer. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

type Attempt = { kind: "response"; outcome: Outcome } | { kind: "retry"; reason: RetryReason };

export class CommandRunner {
  private readonly outbox: Outbox;
  private readonly connectivity: Connectivity;
  private readonly fetchFn: () => typeof fetch;
  private readonly newKey: () => string;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly retryIntervalMs: number;
  private readonly listeners = new Set<SettledListener>();
  private readonly inFlight = new Map<string, Promise<Attempt>>();
  private flushing: Promise<void> | null = null;

  constructor(options: RunnerOptions) {
    this.outbox = options.outbox;
    this.connectivity = options.connectivity;
    this.fetchFn = options.fetchFn ?? (() => globalThis.fetch.bind(globalThis));
    this.newKey = options.newKey ?? newIdempotencyKey;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.retryIntervalMs = options.retryIntervalMs ?? 5_000;
  }

  /** Called for every outbox entry that reaches a definitive answer during a replay (not for direct submits). */
  onSettled(listener: SettledListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async submit<T = unknown>(spec: CommandSpec): Promise<Outcome<T>> {
    if (spec.persist === false) {
      const entry = this.makeEntry(spec, this.newKey());
      if (!this.connectivity.isBrowserOnline()) return { state: "unsent", reason: "offline" };
      const attempt = await this.transmit(entry, false, false);
      return attempt.kind === "response" ? (attempt.outcome as Outcome<T>) : { state: "unsent", reason: attempt.reason };
    }

    // Reuse the key of an identical pending action (a second tap, a reload);
    // a changed body is a different request and must get a new key (the
    // server rejects key reuse with a different body: 422 idempotency-key-reused).
    const existing = spec.dedupeId === undefined ? undefined : this.outbox.find(spec.dedupeId);
    const entry =
      existing !== undefined && sameBody(existing.body, spec.body)
        ? existing
        : this.makeEntry(spec, this.newKey());
    // Persist BEFORE the first byte leaves: a reload mid-request must find it.
    this.outbox.put(entry);

    // The browser says there is no network at all: do not even try. (A merely
    // unreachable edge is still tried: an operator's tap is a fine probe.)
    if (!this.connectivity.isBrowserOnline()) return { state: "queued", key: entry.key, reason: "offline" };

    // Preserve FIFO: older queued commands go first. If one of them cannot be
    // delivered this one waits behind it.
    if (!(await this.drainBefore(entry.key))) {
      return { state: "queued", key: entry.key, reason: "unavailable" };
    }

    const attempt = await this.transmit(entry, true, false);
    if (attempt.kind === "retry") return { state: "queued", key: entry.key, reason: attempt.reason };
    return attempt.outcome as Outcome<T>;
  }

  /**
   * Replays every pending command, oldest first, each with its stored key.
   * Stops at the first one that still cannot be delivered, so order is kept.
   */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Start replaying on reconnect and on an interval while anything is pending. Returns stop(). */
  start(target: Pick<Window, "addEventListener" | "removeEventListener"> = window): () => void {
    const kick = () => void this.flush();
    target.addEventListener("online", kick);
    const timer = setInterval(() => {
      if (this.outbox.list().length > 0) kick();
    }, this.retryIntervalMs);
    kick(); // resume whatever a previous page load left behind
    return () => {
      target.removeEventListener("online", kick);
      clearInterval(timer);
    };
  }

  private async doFlush(): Promise<void> {
    for (const entry of [...this.outbox.list()]) {
      if (this.outbox.get(entry.key) === undefined) continue;
      const attempt = await this.transmit(entry, true, true);
      if (attempt.kind === "retry") return;
    }
  }

  /** Delivers every entry queued ahead of `key`. false => one is still stuck. */
  private async drainBefore(key: string): Promise<boolean> {
    if (this.flushing !== null) await this.flushing;
    for (const older of [...this.outbox.list()]) {
      if (older.key === key) return true;
      if (this.outbox.get(older.key) === undefined) continue;
      const attempt = await this.transmit(older, true, true);
      if (attempt.kind === "retry") return false;
    }
    return true;
  }

  private makeEntry(spec: CommandSpec, key: string): OutboxEntry {
    return {
      key,
      kind: spec.kind,
      method: spec.method ?? "POST",
      path: spec.path,
      ...(spec.body === undefined ? {} : { body: spec.body }),
      ...(spec.dedupeId === undefined ? {} : { dedupeId: spec.dedupeId }),
      meta: spec.meta ?? {},
      createdAt: this.now(),
      attempts: 0,
    };
  }

  /** One HTTP attempt for an entry; concurrent calls for the same key share one request. */
  private transmit(entry: OutboxEntry, persisted: boolean, notify: boolean): Promise<Attempt> {
    const running = this.inFlight.get(entry.key);
    if (running !== undefined) return running;
    const p = this.doTransmit(entry, persisted, notify).finally(() => this.inFlight.delete(entry.key));
    this.inFlight.set(entry.key, p);
    return p;
  }

  private async doTransmit(entry: OutboxEntry, persisted: boolean, notify: boolean): Promise<Attempt> {
    if (persisted) this.outbox.update(entry.key, { attempts: entry.attempts + 1 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn()(entry.path, {
        method: entry.method,
        headers: {
          Accept: "application/json, application/problem+json",
          "Idempotency-Key": entry.key,
          ...(entry.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(entry.body === undefined ? {} : { body: JSON.stringify(entry.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      this.connectivity.reportUnreachable();
      log.warn("request did not reach the edge", entry.kind, entry.path, error);
      return { kind: "retry", reason: "unreachable" };
    } finally {
      clearTimeout(timer);
    }

    this.connectivity.reportReachable();
    if (RETRYABLE_STATUS.has(response.status)) {
      log.warn("edge asked us to retry", entry.kind, entry.path, response.status);
      return { kind: "retry", reason: "unavailable" };
    }

    const outcome = await readOutcome(response);
    // Any other answer is final for this action: the entry is done with.
    if (persisted) this.outbox.remove(entry.key);
    if (notify) for (const l of [...this.listeners]) l(entry, outcome);
    return { kind: "response", outcome };
  }
}

async function readOutcome(response: Response): Promise<Outcome> {
  const text = await response.text().catch(() => "");
  if (response.ok) {
    let data: unknown;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    const dateHeader = response.headers.get("date");
    const parsed = dateHeader === null ? Number.NaN : Date.parse(dateHeader);
    return {
      state: "done",
      status: response.status,
      data,
      serverTime: Number.isNaN(parsed) ? undefined : parsed,
    };
  }
  return {
    state: "problem",
    status: response.status,
    problem: parseProblem(response.status, response.statusText, text),
  };
}

function sameBody(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
