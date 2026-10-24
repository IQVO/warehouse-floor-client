import { createContext, use } from "react";
import type { Message } from "../../api/problemMessages";
import type {
  CompletionConfirmation,
  PickScanResult,
  Station,
  Task,
  TaskType,
} from "../../api/fulfillmentExecution";

/** The lease the service grants by default (DefaultLeaseDuration = 5 min); used only when the response gives no usable duration. */
export const DEFAULT_LEASE_MS = 5 * 60_000;
export const MIN_LEASE_MS = 10_000;
export const MAX_LEASE_MS = 60 * 60_000;
/** Renew when no more than this fraction of the lease is left. */
export const RENEW_AT_FRACTION = 0.5;
/** Do not hammer a failing renewal. */
export const RENEW_RETRY_MS = 10_000;
export const STORAGE_KEY = "wfc.station.v1";

export interface HeldTask {
  task: Task;
  /** The lease length, learned at claim time (leaseExpiry - server now). */
  leaseDurationMs: number;
  /** Local-clock deadline. All countdown math is in the local clock domain, immune to device clock skew. */
  leaseExpiresAt: number;
}

export interface Persisted {
  station: Station | null;
  occupantId: string | null;
  held: HeldTask | null;
}

export interface Notice extends Message {
  id: number;
}

export interface ActionResult {
  /** The service answered with success. */
  ok: boolean;
  /** The parsed success body, when the action has one (a pick scan's running total). */
  data?: unknown;
  /** Saved on this device; will be sent when the connection is back. */
  queued: boolean;
}

export interface StationApi {
  station: Station | null;
  occupantId: string | null;
  held: HeldTask | null;
  /** Local-clock "now", ticking once a second while a task is held. */
  now: number;
  /** True while a request for the named action is in flight. */
  busy: string | null;
  notice: Notice | null;
  dismissNotice(): void;
  /** The latest accepted pick scan, whether answered directly or after an outbox replay. Not persisted. */
  lastScan: { taskId: string; result: PickScanResult } | null;
  /** Whether the renewal timer's last attempt failed (the lease may lapse). */
  renewFailing: boolean;
  register(input: { stationId: string; capabilities: string[]; locationCode?: string }): Promise<ActionResult>;
  checkIn(occupantId: string): Promise<ActionResult>;
  checkOut(): Promise<ActionResult>;
  claimNext(taskType: TaskType): Promise<ActionResult>;
  completeTask(confirmation?: CompletionConfirmation): Promise<ActionResult>;
  /** One scan of an each/case GTIN (14 digits) against the held PICK task. `data` is a PickScanResult when ok. */
  scanPick(gtin: string): Promise<ActionResult>;
  /** Break the sealed case of the held BREAK_CASE task; completes the task. */
  breakCase(): Promise<ActionResult>;
  /** Replay the outbox right now (the "Retry now" button). */
  retryNow(): void;
}

export const StationContext = createContext<StationApi | null>(null);

export function useStation(): StationApi {
  const ctx = use(StationContext);
  if (ctx === null) throw new Error("useStation outside <StationProvider>");
  return ctx;
}

export function loadPersisted(raw: string | null): Persisted {
  const empty: Persisted = { station: null, occupantId: null, held: null };
  if (raw === null) return empty;
  try {
    const v = JSON.parse(raw) as Partial<Persisted>;
    const station = v.station && typeof v.station.id === "string" ? v.station : null;
    const held =
      v.held && typeof v.held.task?.id === "string" && typeof v.held.leaseExpiresAt === "number" && typeof v.held.leaseDurationMs === "number"
        ? v.held
        : null;
    return { station, occupantId: typeof v.occupantId === "string" ? v.occupantId : null, held: station ? held : null };
  } catch {
    return empty;
  }
}

/** Lease length from a claim response: the service's own expiry minus the service's own clock. */
export function leaseDurationFromClaim(task: Task, serverTime: number | undefined, localNow: number): number {
  if (typeof task.leaseExpiry !== "string") return DEFAULT_LEASE_MS;
  const expiry = Date.parse(task.leaseExpiry);
  const ms = expiry - (serverTime ?? localNow);
  return Number.isFinite(ms) && ms >= MIN_LEASE_MS && ms <= MAX_LEASE_MS ? ms : DEFAULT_LEASE_MS;
}

