import type { KnownRejectionReason, Move, Purpose, Trailer, YardLocation } from "../../api/yardManagement";

export const placeText = (l: YardLocation | null | undefined): string => (l ? `${l.kind === "DOOR" ? "Door" : "Spot"} ${l.code}` : "—");

const REASONS: Record<Move["reason"], string> = {
  TO_DOOR: "to a door",
  FROM_DOOR: "off a door",
  TO_SPOT: "to a parking spot",
  RELOCATE: "relocate",
  TO_HOLDING: "to the holding area",
};
export const reasonText = (r: Move["reason"]): string => REASONS[r] ?? r;

const PURPOSES: Record<Purpose, string> = {
  DROP: "Drop a trailer",
  LIVE_UNLOAD: "Live unload",
  LIVE_LOAD: "Live load",
  PICKUP: "Pick up a trailer",
  BOBTAIL: "Bobtail (no trailer)",
};
export const purposeText = (p: Purpose): string => PURPOSES[p] ?? p;

/** "—" when the service gave no due time; never a calm default. */
export function dueText(move: Move): string {
  const due = move.priority.dueBy;
  if (due === null || due === undefined) return "—";
  const t = Date.parse(due);
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const REJECTION_TEXT: Record<KnownRejectionReason, string> = {
  APPOINTMENT_REQUIRED: "No appointment, and this site needs one",
  UNKNOWN_APPOINTMENT: "The appointment is not known",
  SEAL_MISMATCH: "The seal does not match",
  TRAILER_ALREADY_ON_SITE: "That trailer is already on site",
  SITE_REQUEST: "The site asked for it",
  CARRIER_SUSPENDED: "The carrier is suspended",
};

/**
 * Words for a visit's rejection reason as the service sent it. A reason this build does not know is named by
 * its code ("reason <CODE>"), never `undefined`; a REJECTED visit with no reason keeps the site-request wording.
 */
export function rejectionText(reason: string | null | undefined): string {
  const code = reason?.trim() ?? "";
  if (code === "") return REJECTION_TEXT.SITE_REQUEST;
  // Own keys only: "constructor" or "toString" is not a reason.
  return Object.hasOwn(REJECTION_TEXT, code) ? REJECTION_TEXT[code as KnownRejectionReason] : `reason ${code}`;
}

/**
 * The service's rule, shown as a hint only (it decides): a trailer is released
 * when it has no open move and is PARKED, or DOCKED with door work DONE.
 */
export function releaseBlocker(t: Trailer): string | null {
  if (t.openMoveId) return "a move is still open";
  if (t.state === "PARKED") return null;
  if (t.state === "DOCKED") return t.doorWork === "DONE" ? null : "door work is not finished";
  return "it is on the move";
}
