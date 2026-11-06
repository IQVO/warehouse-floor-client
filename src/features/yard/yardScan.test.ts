import { describe, expect, it } from "vitest";
import { readYardCode } from "./yardScan";

/** A real GS1 pair: the SSCC and GTIN the receiving tests use. */
const SSCC = "340123450000000017";
const GTIN = "03041090004827";
const GS = "\u001d";

describe("readYardCode (scan-first yard labels through parseScan)", () => {
  it("accepts a facility-layout location code and a unit number verbatim", () => {
    expect(readYardCode("WH1-DOCK-IN-01", "location")).toEqual({ ok: true, code: "WH1-DOCK-IN-01" });
    expect(readYardCode("TRL-4471", "unit")).toEqual({ ok: true, code: "TRL-4471" });
    expect(readYardCode("ABCD 123456", "unit")).toEqual({ ok: true, code: "ABCD 123456" });
  });

  it("strips the wedge's control characters and trims", () => {
    expect(readYardCode("  WH1-YARD-07\r\n", "location")).toEqual({ ok: true, code: "WH1-YARD-07" });
    expect(readYardCode("\tTRL-9\u0000", "unit")).toEqual({ ok: true, code: "TRL-9" });
  });

  it("accepts a short digit-only code that is no GS1 length (parseScan: bad-length)", () => {
    expect(readYardCode("0042", "location")).toEqual({ ok: true, code: "0042" });
  });

  it("refuses a carton or product barcode so it can never become a door code", () => {
    for (const scan of [SSCC, GTIN, `]C1${"00"}${SSCC}`, `(01)${GTIN}(10)LOT1`, `01${GTIN}10LOT1${GS}17261231`]) {
      const r = readYardCode(scan, "location");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/product or carton barcode/);
    }
  });

  it("refuses an unknown symbology prefix, an empty scan and an oversized blob", () => {
    expect(readYardCode("]Z9WH1-YARD-01", "location").ok).toBe(false);
    expect(readYardCode("", "unit").ok).toBe(false);
    expect(readYardCode("\r\n", "unit").ok).toBe(false);
    expect(readYardCode("A".repeat(129), "location").ok).toBe(false);
  });

  it("applies the API's length limits per kind (unit 64, location 128)", () => {
    expect(readYardCode("U".repeat(65), "unit").ok).toBe(false);
    expect(readYardCode("U".repeat(64), "unit").ok).toBe(true);
    expect(readYardCode("L".repeat(128), "location").ok).toBe(true);
  });

  it("refuses non-printable text", () => {
    expect(readYardCode("WH1-\u00e9", "location").ok).toBe(false);
  });
});
