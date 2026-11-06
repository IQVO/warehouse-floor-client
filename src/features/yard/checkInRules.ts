import type { CheckInRequest, LoadState, Purpose, RejectionReason, RejectRequest, TrailerKind } from "../../api/yardManagement";
import { LOAD_STATES, PURPOSES, REJECTION_REASONS, TRAILER_KINDS } from "../../api/yardManagement";

export interface TrailerDraft {
  unitNumber: string;
  kind: TrailerKind | "";
  loadState: LoadState | "";
  sealNumber: string;
}

export interface CheckInDraft {
  carrier: string;
  carrierScac: string;
  tractorPlate: string;
  driverRef: string;
  purpose: Purpose | "";
  appointmentId: string;
  trailers: TrailerDraft[];
}

export const emptyCheckIn: CheckInDraft = { carrier: "", carrierScac: "", tractorPlate: "", driverRef: "", purpose: "", appointmentId: "", trailers: [] };

export type Built<T> = { ok: true; body: T } | { ok: false; message: string };

/** A bobtail brings no trailer, and a pickup takes one that is already on site (OpenAPI CheckInVisitRequest.trailers). */
export const bringsTrailers = (purpose: Purpose | ""): boolean => purpose !== "BOBTAIL" && purpose !== "PICKUP";

const SCAC = /^[A-Z]{2,4}$/;

export function emptyTrailer(unitNumber: string): TrailerDraft {
  return { unitNumber, kind: "", loadState: "", sealNumber: "" };
}

/** Plate and carrier code are written in capitals on the paperwork; send them that way. */
function caps(s: string): string {
  return s.trim().toUpperCase();
}

function visitFields(siteId: string, d: Pick<CheckInDraft, "carrier" | "carrierScac" | "tractorPlate" | "appointmentId">): { message: string } | { fields: Pick<CheckInRequest, "siteId" | "carrier" | "tractorPlate"> & Partial<Pick<CheckInRequest, "carrierScac" | "appointmentId">> } {
  const carrier = d.carrier.trim();
  const plate = caps(d.tractorPlate);
  const scac = caps(d.carrierScac);
  const appointmentId = d.appointmentId.trim();
  if (siteId.trim() === "") return { message: "Enter the site code first." };
  if (carrier === "") return { message: "Enter the carrier." };
  if (carrier.length > 100) return { message: "The carrier name is too long (100 characters at most)." };
  if (plate === "") return { message: "Enter the tractor plate." };
  if (plate.length > 32) return { message: "The tractor plate is too long (32 characters at most)." };
  if (scac !== "" && !SCAC.test(scac)) return { message: "The carrier code is 2 to 4 capital letters, or leave it empty." };
  if (appointmentId.length > 64) return { message: "The appointment id is too long (64 characters at most)." };
  return {
    fields: { siteId: siteId.trim(), carrier, tractorPlate: plate, ...(scac === "" ? {} : { carrierScac: scac }), ...(appointmentId === "" ? {} : { appointmentId }) },
  };
}

/**
 * The check-in request, or the sentence that says what is missing. Trailer
 * rules follow the OpenAPI: a visit that names an appointment brings exactly
 * ONE trailer, otherwise one or more; a bobtail or a pickup brings none.
 */
export function buildCheckIn(siteId: string, d: CheckInDraft): Built<CheckInRequest> {
  const base = visitFields(siteId, d);
  if ("message" in base) return { ok: false, message: base.message };
  if (d.purpose === "" || !PURPOSES.includes(d.purpose)) return { ok: false, message: "Choose what the truck is here to do." };
  const driverRef = d.driverRef.trim();
  if (driverRef.length > 64) return { ok: false, message: "The driver reference is too long (64 characters at most)." };

  const request: CheckInRequest = { ...base.fields, purpose: d.purpose, ...(driverRef === "" ? {} : { driverRef }) };
  if (!bringsTrailers(d.purpose)) {
    if (d.trailers.length > 0) return { ok: false, message: "This purpose brings no trailer. Remove the trailers listed, or change the purpose." };
    return { ok: true, body: request };
  }

  const n = d.trailers.length;
  if (request.appointmentId !== undefined && n !== 1) return { ok: false, message: "A visit with an appointment brings exactly one trailer." };
  if (n === 0) return { ok: false, message: "Scan the trailer unit number. At least one trailer is needed." };

  const seen = new Set<string>();
  const trailers = [];
  for (const [i, t] of d.trailers.entries()) {
    const unitNumber = t.unitNumber.trim();
    const label = `Trailer ${i + 1}`;
    if (unitNumber === "") return { ok: false, message: `${label}: enter the unit number.` };
    if (unitNumber.length > 64) return { ok: false, message: `${label}: the unit number is too long (64 characters at most).` };
    if (seen.has(unitNumber.toLowerCase())) return { ok: false, message: `${unitNumber} is listed twice.` };
    seen.add(unitNumber.toLowerCase());
    if (t.kind === "" || !TRAILER_KINDS.includes(t.kind)) return { ok: false, message: `${label}: choose the kind of trailer.` };
    if (t.loadState === "" || !LOAD_STATES.includes(t.loadState)) return { ok: false, message: `${label}: choose whether it is empty, loaded or part loaded.` };
    const seal = t.sealNumber.trim();
    if (seal.length > 64) return { ok: false, message: `${label}: the seal number is too long (64 characters at most).` };
    trailers.push({ unitNumber, kind: t.kind, loadState: t.loadState, ...(seal === "" ? {} : { sealNumber: seal }) });
  }
  return { ok: true, body: { ...request, trailers } };
}

export interface RejectDraft {
  carrier: string;
  carrierScac: string;
  tractorPlate: string;
  appointmentId: string;
  reason: RejectionReason | "";
}

export const emptyReject: RejectDraft = { carrier: "", carrierScac: "", tractorPlate: "", appointmentId: "", reason: "" };

export function buildReject(siteId: string, d: RejectDraft): Built<RejectRequest> {
  const base = visitFields(siteId, d);
  if ("message" in base) return { ok: false, message: base.message };
  if (d.reason === "" || !REJECTION_REASONS.includes(d.reason)) return { ok: false, message: "Choose why the truck is turned away." };
  return { ok: true, body: { ...base.fields, reason: d.reason } };
}
