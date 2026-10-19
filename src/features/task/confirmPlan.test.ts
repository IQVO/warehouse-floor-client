import { describe, expect, it } from "vitest";
import { buildConfirmPlan, scanMatches } from "./confirmPlan";

describe("buildConfirmPlan", () => {
  it("PICK: scan the order label, no quantity, nothing extra in the request", () => {
    const plan = buildConfirmPlan({ id: "t1", type: "PICK", status: "CLAIMED", orderRef: "order-42" });
    if (!plan.supported) throw new Error("expected supported");
    expect(plan.scans).toEqual([{ id: "order", label: "Scan the order label", expected: "order-42" }]);
    expect(plan.quantity).toBeNull();
    expect(plan.toRequest({ order: "order-42" }, undefined)).toEqual({});
  });

  it("RELOCATE Vacate: the planned source is fixed, the destination is open", () => {
    const plan = buildConfirmPlan({
      id: "t2",
      type: "RELOCATE",
      status: "CLAIMED",
      relocation: { planId: "p", moveSeq: 0, kind: "Vacate", sku: "S", fromBin: "A-1", ref: "p:0" },
    });
    if (!plan.supported) throw new Error("expected supported");
    expect(plan.scans.map((s) => [s.id, s.expected])).toEqual([
      ["fromBin", "A-1"],
      ["toBin", undefined],
    ]);
    expect(plan.toRequest({ fromBin: "A-1", toBin: "RSV-9" }, 12)).toEqual({ quantity: 12, fromBin: "A-1", toBin: "RSV-9" });
  });

  it("REPLENISH: both bins fixed, quantity defaults to the plan", () => {
    const plan = buildConfirmPlan({
      id: "t3",
      type: "REPLENISH",
      status: "CLAIMED",
      replenishment: { requestId: "r", sku: "S", fromBin: "R-1", toBin: "F-1", quantity: 24, priority: "NORMAL" },
    });
    if (!plan.supported) throw new Error("expected supported");
    expect(plan.quantity).toEqual({ default: 24 });
    expect(plan.scans.map((s) => s.expected)).toEqual(["R-1", "F-1"]);
  });

  it.each(["PACK", "SLAM", "REBIN", "DISPATCH", "ARRIVAL"])("%s is not finished in this release", (type) => {
    expect(buildConfirmPlan({ id: "t", type, status: "CLAIMED" }).supported).toBe(false);
  });

  it("a RELOCATE or REPLENISH without its plan is unsupported rather than guessed", () => {
    expect(buildConfirmPlan({ id: "t", type: "RELOCATE", status: "CLAIMED" }).supported).toBe(false);
    expect(buildConfirmPlan({ id: "t", type: "REPLENISH", status: "CLAIMED" }).supported).toBe(false);
  });
});

describe("scanMatches", () => {
  it("compares case-insensitively when the plan fixes the value, accepts anything when it does not", () => {
    expect(scanMatches({ id: "toBin", label: "x", expected: "WH1-A" }, "wh1-a")).toBe(true);
    expect(scanMatches({ id: "toBin", label: "x", expected: "WH1-A" }, "WH1-B")).toBe(false);
    expect(scanMatches({ id: "fromBin", label: "x" }, "anything")).toBe(true);
  });
});
