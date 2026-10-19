/** The slice of Storage this app needs; tests pass an in-memory one. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/**
 * localStorage when it works (it throws in some private modes and when quota is
 * exhausted), otherwise memory. Memory means a reload loses the outbox, which
 * the UI cannot tell the operator about -- so prefer failing loudly later over
 * pretending: see Outbox.put, which surfaces a write failure.
 */
export function defaultStore(): KeyValueStore {
  try {
    const probe = "wfc.probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return new MemoryStore();
  }
}
