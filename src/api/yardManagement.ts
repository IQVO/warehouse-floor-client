import type { CommandRunner, Outcome } from "../lib/commands";
import { getJson, type ReadResult } from "./inboundReceiving";

/**
 * yard-management, as far as the gate, hostler and dock screens need it.
 * Shapes, enum values and error slugs are taken from the service's
 * apis/openapi.yaml (`servers`: Kong at /api/yard-management); see
 * docs/docs/ecosystem/api-contract.md.
 *
 * Network rule: the page's own origin, path /api/yard-management/..., which
 * Kong routes. Never a service URL, never a port, never another host.
 */
export const YARD_BASE = "/api/yard-management";

export const PURPOSES = ["DROP", "LIVE_UNLOAD", "LIVE_LOAD", "PICKUP", "BOBTAIL"] as const;
export type Purpose = (typeof PURPOSES)[number];
export const TRAILER_KINDS = ["DRY_VAN", "REEFER", "FLATBED", "CONTAINER"] as const;
export type TrailerKind = (typeof TRAILER_KINDS)[number];
export const LOAD_STATES = ["EMPTY", "LOADED", "PARTIAL"] as const;
export type LoadState = (typeof LOAD_STATES)[number];
export const REJECTION_REASONS = ["APPOINTMENT_REQUIRED", "UNKNOWN_APPOINTMENT", "SEAL_MISMATCH", "TRAILER_ALREADY_ON_SITE", "SITE_REQUEST"] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface YardLocation {
  kind: "SPOT" | "DOOR";
  code: string;
}

export interface Visit {
  visitId: string;
  siteId: string;
  carrier: string;
  carrierScac?: string | null;
  tractorPlate: string;
  driverRef?: string | null;
  purpose: Purpose;
  appointmentId?: string | null;
  state: "CHECKED_IN" | "CHECKED_OUT" | "REJECTED";
  rejectionReason?: RejectionReason | null;
  trailersIn: string[];
  trailersOut: string[];
  arrivedAt: string;
  departedAt?: string | null;
  version: number;
}

export interface Trailer {
  trailerId: string;
  siteId: string;
  unitNumber: string;
  carrierScac?: string | null;
  kind: TrailerKind;
  loadState: LoadState;
  state: "PARKED" | "IN_MOVE" | "DOCKED" | "DEPARTED";
  location?: YardLocation | null;
  doorWork?: "WAITING" | "IN_PROGRESS" | "DONE" | null;
  seal: { number: string | null; state: "NONE" | "INTACT" | "BROKEN" };
  hold?: "DAMAGED" | "SEAL_BROKEN" | "NOT_FOUND" | "QUALITY" | "SECURITY" | null;
  asnNumbers: string[];
  outboundRef?: string | null;
  visitId?: string | null;
  appointmentId?: string | null;
  arrivedAt: string;
  departedAt?: string | null;
  openMoveId?: string | null;
  version: number;
}

export interface Move {
  moveId: string;
  siteId: string;
  trailerId: string;
  appointmentId?: string | null;
  performer: "HOSTLER" | "VISITING_DRIVER";
  from?: YardLocation | null;
  to: YardLocation;
  reason: "TO_DOOR" | "FROM_DOOR" | "TO_SPOT" | "RELOCATE" | "TO_HOLDING";
  priority: { band: number; dueBy?: string | null };
  state: "REQUESTED" | "CLAIMED" | "COMPLETED" | "CANCELLED";
  hostlerRef?: string | null;
  leaseExpiresAt?: string | null;
  actualLocation?: YardLocation | null;
  claimedAt?: string | null;
  completedAt?: string | null;
  requestedAt: string;
  version: number;
}

/** 201 body of POST /visits: a REJECTED visit (seal policy REJECT) comes back with no trailers and no moves. */
export interface CheckIn {
  visit: Visit;
  trailers: Trailer[];
  moves: Move[];
}

export interface TrailerIn {
  unitNumber: string;
  carrierScac?: string;
  kind: TrailerKind;
  loadState: LoadState;
  sealNumber?: string;
}

export interface CheckInRequest {
  siteId: string;
  carrier: string;
  carrierScac?: string;
  tractorPlate: string;
  driverRef?: string;
  purpose: Purpose;
  appointmentId?: string;
  trailers?: TrailerIn[];
}

export interface RejectRequest {
  siteId: string;
  carrier: string;
  carrierScac?: string;
  tractorPlate: string;
  appointmentId?: string;
  reason: RejectionReason;
}

export interface CompleteMoveRequest {
  /** The lease holder; omitted for a VISITING_DRIVER move (gate clerk / dock operator). */
  hostlerRef?: string;
  actualLocation?: YardLocation;
  /** Required by the service when actualLocation is not the destination. */
  deviationNote?: string;
}

const seg = encodeURIComponent;

/**
 * Command builders. Each one is ONE logical action: the dedupeId names it, so a
 * second tap, a reconnect replay or a reload reuses the same Idempotency-Key
 * while the body is unchanged (and a changed body mints a new key).
 */
export function yardManagementApi(runner: CommandRunner) {
  return {
    /** One open visit per tractor plate (`visit-already-open`), so site + plate names the action. */
    checkInVisit(body: CheckInRequest): Promise<Outcome<CheckIn>> {
      return runner.submit<CheckIn>({
        kind: "yard-check-in",
        path: `${YARD_BASE}/visits`,
        body,
        dedupeId: `yard-check-in:${body.siteId}:${body.tractorPlate}`,
        meta: { siteId: body.siteId, tractorPlate: body.tractorPlate },
      });
    },

    rejectAtGate(body: RejectRequest): Promise<Outcome<Visit>> {
      return runner.submit<Visit>({
        kind: "yard-reject",
        path: `${YARD_BASE}/visit-rejections`,
        body,
        dedupeId: `yard-reject:${body.siteId}:${body.tractorPlate}`,
        meta: { siteId: body.siteId, tractorPlate: body.tractorPlate },
      });
    },

    checkOutVisit(visitId: string, trailerIds: string[]): Promise<Outcome<Visit>> {
      return runner.submit<Visit>({
        kind: "yard-check-out",
        path: `${YARD_BASE}/visits/${seg(visitId)}/check-outs`,
        body: { trailersOut: trailerIds.map((trailerId) => ({ trailerId })) },
        dedupeId: `yard-check-out:${visitId}`,
        meta: { visitId },
      });
    },

    /** Pull dispatch: the service picks the move. One claim per hostler at a time (`hostler-busy`). */
    claimNextMove(siteId: string, hostlerRef: string): Promise<Outcome<Move>> {
      return runner.submit<Move>({
        kind: "yard-claim",
        path: `${YARD_BASE}/moves/claims`,
        body: { siteId, hostlerRef },
        dedupeId: `yard-claim:${siteId}:${hostlerRef}`,
        meta: { siteId, hostlerRef },
      });
    },

    completeMove(moveId: string, body: CompleteMoveRequest): Promise<Outcome<Move>> {
      return runner.submit<Move>({
        kind: "yard-complete-move",
        path: `${YARD_BASE}/moves/${seg(moveId)}/completions`,
        body,
        dedupeId: `yard-complete-move:${moveId}`,
        meta: { moveId, ...(body.hostlerRef === undefined ? {} : { hostlerRef: body.hostlerRef }) },
      });
    },

    startDoorWork(trailerId: string): Promise<Outcome<Trailer>> {
      return runner.submit<Trailer>({
        kind: "yard-door-start",
        path: `${YARD_BASE}/trailers/${seg(trailerId)}/door-work-starts`,
        dedupeId: `yard-door-start:${trailerId}`,
        meta: { trailerId },
      });
    },

    completeDoorWork(trailerId: string, loadState?: LoadState): Promise<Outcome<Trailer>> {
      return runner.submit<Trailer>({
        kind: "yard-door-complete",
        path: `${YARD_BASE}/trailers/${seg(trailerId)}/door-work-completions`,
        body: loadState === undefined ? {} : { loadState },
        dedupeId: `yard-door-complete:${trailerId}`,
        meta: { trailerId },
      });
    },
  };
}

export type YardManagementApi = ReturnType<typeof yardManagementApi>;

interface Page<T> {
  items: T[];
  nextCursor?: string | null;
}

/** Pages followed per list (limit 500 each): a bound, so a misbehaving server cannot loop a screen forever. */
export const YARD_LIST_MAX_PAGES = 10;

/** Every item of a keyset-paged list: follows `nextCursor` until it is absent (STANDARD 5.2). */
async function listAll<T>(path: string, query: Record<string, string | undefined>, fetchFn?: typeof fetch): Promise<ReadResult<T[]>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < YARD_LIST_MAX_PAGES; page++) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") q.set(k, v);
    q.set("limit", "500");
    if (cursor !== undefined) q.set("cursor", cursor);
    const result = await getJson<Page<T>>(`${path}?${q.toString()}`, fetchFn);
    if (result.state !== "done") return result;
    items.push(...result.data.items);
    cursor = result.data.nextCursor ?? undefined;
    if (cursor === undefined || cursor === "") break;
  }
  return { state: "done", data: items };
}

/** Plain GETs (reads are not commands: no key, no outbox). Failures never throw. */
export const yardReads = {
  listVisits: (q: { siteId: string; state?: Visit["state"]; tractorPlate?: string }, fetchFn?: typeof fetch) =>
    listAll<Visit>(`${YARD_BASE}/visits`, q, fetchFn),
  getVisit: (visitId: string, fetchFn?: typeof fetch) => getJson<Visit>(`${YARD_BASE}/visits/${seg(visitId)}`, fetchFn),
  listTrailers: (q: { siteId: string; state?: Trailer["state"]; unitNumber?: string; locationCode?: string }, fetchFn?: typeof fetch) =>
    listAll<Trailer>(`${YARD_BASE}/trailers`, q, fetchFn),
  getTrailer: (trailerId: string, fetchFn?: typeof fetch) => getJson<Trailer>(`${YARD_BASE}/trailers/${seg(trailerId)}`, fetchFn),
  listMoves: (q: { siteId: string; state?: Move["state"]; trailerId?: string }, fetchFn?: typeof fetch) =>
    listAll<Move>(`${YARD_BASE}/moves`, q, fetchFn),
};
