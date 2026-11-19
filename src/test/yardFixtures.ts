import type { CheckIn, Move, Trailer, Visit } from "../api/yardManagement";

export const YB = "/api/yard-management";
export const YARD_ERRORS = "https://errors.yard-management.warehouse-systems.dev";

export function yardProblem(status: number, slug: string, title = "Refused", detail = "usecases: engineer wording"): Response {
  return new Response(JSON.stringify({ type: `${YARD_ERRORS}/${slug}`, title, status, detail }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

export function visit(over: Partial<Visit> = {}): Visit {
  return {
    visitId: "visit-1",
    siteId: "WH1",
    carrier: "Acme Freight",
    carrierScac: "ACME",
    tractorPlate: "ABC1234",
    purpose: "LIVE_UNLOAD",
    appointmentId: "appt-1",
    state: "CHECKED_IN",
    trailersIn: ["trl-1"],
    trailersOut: [],
    arrivedAt: "2026-11-06T10:00:00Z",
    version: 1,
    ...over,
  };
}

export function trailer(over: Partial<Trailer> = {}): Trailer {
  return {
    trailerId: "trl-1",
    siteId: "WH1",
    unitNumber: "TRL-4471",
    kind: "DRY_VAN",
    loadState: "LOADED",
    state: "IN_MOVE",
    location: null,
    doorWork: null,
    seal: { number: "S-100", state: "INTACT" },
    asnNumbers: [],
    visitId: "visit-1",
    appointmentId: "appt-1",
    arrivedAt: "2026-11-06T10:00:00Z",
    openMoveId: "mv-1",
    version: 1,
    ...over,
  };
}

export function move(over: Partial<Move> = {}): Move {
  return {
    moveId: "mv-1",
    siteId: "WH1",
    trailerId: "trl-1",
    performer: "VISITING_DRIVER",
    from: null,
    to: { kind: "DOOR", code: "WH1-DOCK-IN-01" },
    reason: "TO_DOOR",
    priority: { band: 1, dueBy: null },
    state: "CLAIMED",
    requestedAt: "2026-11-06T10:00:00Z",
    version: 1,
    ...over,
  };
}

export function checkIn(over: Partial<CheckIn> = {}): CheckIn {
  return { visit: visit(), trailers: [trailer()], moves: [move()], ...over };
}
