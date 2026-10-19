import { describe, expect, it } from "vitest";
import { createScanDeduper, isEditable, isPrintableKey, normalizeScan } from "./scan";

describe("normalizeScan", () => {
  it("strips CR/LF/TAB and surrounding whitespace added by scanner suffix settings", () => {
    expect(normalizeScan("  ORD-42\r\n")).toBe("ORD-42");
    expect(normalizeScan("\tWH1-FWD-A01\t")).toBe("WH1-FWD-A01");
  });

  it("removes embedded control characters", () => {
    expect(normalizeScan("AB\u0000C\u001bD")).toBe("ABCD");
  });

  it("rejects an empty or oversized scan", () => {
    expect(normalizeScan("   \r\n")).toBe("");
    expect(normalizeScan("x".repeat(129))).toBe("");
    expect(normalizeScan("x".repeat(128))).toHaveLength(128);
  });
});

describe("createScanDeduper", () => {
  it("drops the same value fired twice inside the window (trigger bounce) but not a different one", () => {
    let t = 1000;
    const d = createScanDeduper(400, () => t);
    expect(d.accept("A")).toBe(true);
    t += 100;
    expect(d.accept("A")).toBe(false);
    t += 100;
    expect(d.accept("B")).toBe(true);
  });

  it("accepts the same value again after the window", () => {
    let t = 0;
    const d = createScanDeduper(400, () => t);
    expect(d.accept("A")).toBe(true);
    t = 401;
    expect(d.accept("A")).toBe(true);
  });
});

describe("key classification", () => {
  it("treats single characters as printable and shortcuts/navigation as not", () => {
    const base = { ctrlKey: false, metaKey: false, altKey: false };
    expect(isPrintableKey({ ...base, key: "a" })).toBe(true);
    expect(isPrintableKey({ ...base, key: "Enter" })).toBe(false);
    expect(isPrintableKey({ ...base, key: "v", ctrlKey: true })).toBe(false);
  });

  it("recognises editable targets", () => {
    expect(isEditable(document.createElement("input"))).toBe(true);
    expect(isEditable(document.createElement("button"))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});
