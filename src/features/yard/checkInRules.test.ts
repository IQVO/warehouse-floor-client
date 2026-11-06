import { describe, expect, it } from "vitest";
import { buildCheckIn, buildReject, bringsTrailers, emptyCheckIn, emptyReject, emptyTrailer, type CheckInDraft } from "./checkInRules";

const trailerOk = { ...emptyTrailer("TRL-1"), kind: "DRY_VAN" as const, loadState: "LOADED" as const };
const base: CheckInDraft = { ...emptyCheckIn, carrier: "Acme Freight", tractorPlate: "abc1234", purpose: "DROP", trailers: [trailerOk] };

function fails(draft: CheckInDraft, site = "WH1") {
  const r = buildCheckIn(site, draft);
  if (r.ok) throw new Error("expected a refusal");
  return r.message;
}

describe("buildCheckIn", () => {
  it("builds the request of apis/openapi.yaml CheckInVisitRequest, plate and carrier code in capitals", () => {
    const r = buildCheckIn("WH1", { ...base, carrierScac: "acme", driverRef: " drv-9 ", trailers: [{ ...trailerOk, sealNumber: " S-100 " }] });
    expect(r).toEqual({
      ok: true,
      body: {
        siteId: "WH1",
        carrier: "Acme Freight",
        carrierScac: "ACME",
        tractorPlate: "ABC1234",
        driverRef: "drv-9",
        purpose: "DROP",
        trailers: [{ unitNumber: "TRL-1", kind: "DRY_VAN", loadState: "LOADED", sealNumber: "S-100" }],
      },
    });
  });

  it("omits what is empty instead of sending empty strings", () => {
    const r = buildCheckIn("WH1", base);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(Object.keys(r.body).sort()).toEqual(["carrier", "purpose", "siteId", "tractorPlate", "trailers"]);
  });

  it("an appointment needs exactly one trailer; without one, one or more", () => {
    expect(fails({ ...base, appointmentId: "appt-1", trailers: [] })).toMatch(/exactly one trailer/);
    expect(fails({ ...base, appointmentId: "appt-1", trailers: [trailerOk, { ...trailerOk, unitNumber: "TRL-2" }] })).toMatch(/exactly one trailer/);
    expect(buildCheckIn("WH1", { ...base, appointmentId: " appt-1 " })).toMatchObject({ ok: true, body: { appointmentId: "appt-1" } });
    expect(fails({ ...base, trailers: [] })).toMatch(/At least one trailer/);
    expect(buildCheckIn("WH1", { ...base, trailers: [trailerOk, { ...trailerOk, unitNumber: "TRL-2" }] })).toMatchObject({ ok: true });
  });

  it("a bobtail or a pickup brings no trailer", () => {
    expect(bringsTrailers("BOBTAIL")).toBe(false);
    expect(bringsTrailers("PICKUP")).toBe(false);
    expect(bringsTrailers("DROP")).toBe(true);
    expect(buildCheckIn("WH1", { ...base, purpose: "BOBTAIL", trailers: [] })).toMatchObject({ ok: true });
    const r = buildCheckIn("WH1", { ...base, purpose: "PICKUP", trailers: [] });
    expect(r.ok && r.body.trailers).toBeUndefined();
    expect(fails({ ...base, purpose: "BOBTAIL" })).toMatch(/no trailer/);
  });

  it("refuses the missing and the invalid, each in a sentence", () => {
    expect(fails(base, "")).toMatch(/site code/);
    expect(fails({ ...base, carrier: " " })).toMatch(/carrier/);
    expect(fails({ ...base, tractorPlate: "" })).toMatch(/tractor plate/);
    expect(fails({ ...base, carrierScac: "A" })).toMatch(/2 to 4 capital/);
    expect(fails({ ...base, carrierScac: "ABCDE" })).toMatch(/2 to 4 capital/);
    expect(fails({ ...base, purpose: "" })).toMatch(/Choose what/);
    expect(fails({ ...base, trailers: [{ ...trailerOk, kind: "" }] })).toMatch(/kind of trailer/);
    expect(fails({ ...base, trailers: [{ ...trailerOk, loadState: "" }] })).toMatch(/empty, loaded/);
    expect(fails({ ...base, trailers: [{ ...trailerOk, unitNumber: "  " }] })).toMatch(/unit number/);
    expect(fails({ ...base, trailers: [trailerOk, { ...trailerOk, unitNumber: "trl-1" }] })).toMatch(/listed twice/);
  });

  it("enforces the API's length limits", () => {
    expect(fails({ ...base, carrier: "x".repeat(101) })).toMatch(/too long/);
    expect(fails({ ...base, tractorPlate: "x".repeat(33) })).toMatch(/too long/);
    expect(fails({ ...base, appointmentId: "x".repeat(65) })).toMatch(/too long/);
    expect(fails({ ...base, driverRef: "x".repeat(65) })).toMatch(/too long/);
    expect(fails({ ...base, trailers: [{ ...trailerOk, unitNumber: "x".repeat(65) }] })).toMatch(/too long/);
    expect(fails({ ...base, trailers: [{ ...trailerOk, sealNumber: "x".repeat(65) }] })).toMatch(/too long/);
  });
});

describe("buildReject", () => {
  it("builds RejectVisitRequest and needs a reason", () => {
    const d = { ...emptyReject, carrier: "Acme", tractorPlate: "zz9", appointmentId: "appt-9", reason: "SEAL_MISMATCH" as const };
    expect(buildReject("WH1", d)).toEqual({ ok: true, body: { siteId: "WH1", carrier: "Acme", tractorPlate: "ZZ9", appointmentId: "appt-9", reason: "SEAL_MISMATCH" } });
    const r = buildReject("WH1", { ...d, reason: "" });
    expect(r.ok).toBe(false);
    expect(buildReject("", d).ok).toBe(false);
  });
});
