import type { KeyValueStore } from "./storage";

/**
 * A command that has been (or is about to be) sent and has no definitive
 * answer yet. Persisted so that neither a reload nor a dead battery mints a
 * second Idempotency-Key for the same operator action.
 */
export interface OutboxEntry {
  /** The Idempotency-Key. Minted once; never changes for this entry. */
  key: string;
  /** What the command is, e.g. "complete"; the app maps it back to a handler on replay. */
  kind: string;
  method: "POST" | "PUT";
  /** Same-origin path through Kong, e.g. /api/fulfillment-execution/tasks/1/complete. */
  path: string;
  body?: unknown;
  /**
   * Identifies the logical action ("complete:task-1"). Submitting the same
   * action again while it is still pending reuses this entry (and so its key)
   * when the body is unchanged.
   */
  dedupeId?: string;
  /** Opaque context the app needs to apply the result after a replay. */
  meta: Record<string, string>;
  createdAt: number;
  attempts: number;
}

const STORAGE_KEY = "wfc.outbox.v1";

function isEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    v.key !== "" &&
    typeof v.kind === "string" &&
    (v.method === "POST" || v.method === "PUT") &&
    typeof v.path === "string" &&
    v.path.startsWith("/api/") &&
    typeof v.createdAt === "number" &&
    typeof v.attempts === "number" &&
    typeof v.meta === "object" &&
    v.meta !== null
  );
}

type Listener = () => void;

/** FIFO, persisted. Reads through to the store so a fresh instance sees what a previous page load left. */
export class Outbox {
  private readonly listeners = new Set<Listener>();
  private readonly store: KeyValueStore;
  private readonly storageKey: string;
  private snapshot: readonly OutboxEntry[];

  constructor(store: KeyValueStore, storageKey: string = STORAGE_KEY) {
    this.store = store;
    this.storageKey = storageKey;
    this.snapshot = this.read();
  }

  /** Stable reference between changes (safe for useSyncExternalStore). */
  list(): readonly OutboxEntry[] {
    return this.snapshot;
  }

  find(dedupeId: string): OutboxEntry | undefined {
    return this.snapshot.find((e) => e.dedupeId === dedupeId);
  }

  get(key: string): OutboxEntry | undefined {
    return this.snapshot.find((e) => e.key === key);
  }

  /** Inserts, or replaces the entry with the same key / dedupeId in place (keeping its queue position). */
  put(entry: OutboxEntry): void {
    const next = [...this.snapshot];
    const at = next.findIndex(
      (e) => e.key === entry.key || (entry.dedupeId !== undefined && e.dedupeId === entry.dedupeId),
    );
    if (at >= 0) next[at] = entry;
    else next.push(entry);
    this.commit(next);
  }

  update(key: string, patch: Partial<Pick<OutboxEntry, "attempts">>): void {
    this.commit(this.snapshot.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }

  remove(key: string): void {
    if (this.snapshot.some((e) => e.key === key)) {
      this.commit(this.snapshot.filter((e) => e.key !== key));
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-read the store (another tab may have written it) and notify if it changed. */
  refresh(): void {
    const next = this.read();
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot)) {
      this.snapshot = next;
      this.emit();
    }
  }

  private read(): OutboxEntry[] {
    try {
      const raw = this.store.getItem(this.storageKey);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      // Corrupt JSON: dropping it is the only option, and a stuck outbox is worse.
      return [];
    }
  }

  private commit(next: OutboxEntry[]): void {
    // Persist first: if the write throws (quota), the in-memory view must not
    // claim the command is safely stored.
    this.store.setItem(this.storageKey, JSON.stringify(next));
    this.snapshot = next;
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
