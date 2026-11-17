import { describe, expect, it } from "vitest";
import { REJECTION_REASONS, SERVICE_REJECTION_REASONS } from "../../api/yardManagement";
import { REJECTION_TEXT, rejectionText } from "./yardFormat";

describe("rejectionText", () => {
  it("says a suspended carrier in plain words (CARRIER_SUSPENDED, set by the service only)", () => {
    expect(rejectionText("CARRIER_SUSPENDED")).toBe("The carrier is suspended");
  });

  it("has operator wording for every reason the Visit schema names", () => {
    for (const reason of [...REJECTION_REASONS, ...SERVICE_REJECTION_REASONS]) {
      expect(rejectionText(reason), reason).toBe(REJECTION_TEXT[reason]);
      expect(rejectionText(reason), reason).not.toMatch(/undefined|_/);
    }
  });

  it("names a reason this build does not know by its code, never `undefined`", () => {
    expect(rejectionText("DRIVER_NOT_ON_LIST")).toBe("reason DRIVER_NOT_ON_LIST");
    // Names every object inherits are not reasons this build knows.
    expect(rejectionText("constructor")).toBe("reason constructor");
    expect(rejectionText("toString")).toBe("reason toString");
  });

  it("a REJECTED visit with no reason keeps the wording it always had", () => {
    expect(rejectionText(null)).toBe("The site asked for it");
    expect(rejectionText(undefined)).toBe("The site asked for it");
    expect(rejectionText("  ")).toBe("The site asked for it");
  });
});
