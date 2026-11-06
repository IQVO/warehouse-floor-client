import type { Move } from "../../api/yardManagement";
import type { KeyValueStore } from "../../lib/storage";

export const HOSTLER_KEY = "wfc.yard.hostler.v1";

/** The move this device's hostler holds, kept so a reload does not lose it. */
export interface HeldMove {
  move: Move;
  /** Trailer unit number, once looked up (the claim answer carries only the trailer id). */
  unit?: string;
  /**
   * Local-clock deadline of the lease, or null when the service gave none.
   * All countdown math is in the local clock domain, immune to device clock skew.
   */
  leaseDeadline: number | null;
}

export function loadHeld(store: KeyValueStore): HeldMove | null {
  try {
    const raw = store.getItem(HOSTLER_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<HeldMove> | null;
    if (v?.move === undefined || typeof v.move.moveId !== "string" || typeof v.move.to?.code !== "string") return null;
    return {
      move: v.move,
      ...(typeof v.unit === "string" ? { unit: v.unit } : {}),
      leaseDeadline: typeof v.leaseDeadline === "number" ? v.leaseDeadline : null,
    };
  } catch {
    return null;
  }
}

export function saveHeld(store: KeyValueStore, held: HeldMove | null): void {
  if (held === null) store.removeItem(HOSTLER_KEY);
  else store.setItem(HOSTLER_KEY, JSON.stringify(held));
}

/**
 * Local deadline of a lease: the service's own expiry minus the service's own
 * clock (the response `Date`), added to the local clock. Without a response
 * date (a plain GET) the local clock stands in for it. null: no usable expiry.
 */
export function leaseDeadline(leaseExpiresAt: string | null | undefined, serverTime: number | undefined, localNow: number): number | null {
  if (typeof leaseExpiresAt !== "string") return null;
  const expiry = Date.parse(leaseExpiresAt);
  if (Number.isNaN(expiry)) return null;
  return localNow + (expiry - (serverTime ?? localNow));
}
