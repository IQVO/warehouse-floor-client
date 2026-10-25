import { describe, expect, it } from "vitest";
import { REFERENCE_BITS, decodeModules } from "../../test/code128Reference";
import { parseScan } from "../gs1";
import { code128Checksum, encodeCode128B, encodeGs1128Sscc, patternModules } from "./code128";
import { QUIET_ZONE_MODULES, barRuns, formatSsccHumanReadable, labelBarcodeFor } from "./labelBarcode";

const SSCC = "340123450000000017";
const LPN = "LPN-01K8Z3Q5R7T9V1W2X4Y6A8B0CD";
const GS = "\u001d";

describe("symbol character table", () => {
  it("matches the independent ISO/IEC 15417 reference for all 107 characters", () => {
    expect(REFERENCE_BITS).toHaveLength(107);
    for (let code = 0; code <= 106; code++) expect(patternModules(code), `code ${code}`).toBe(REFERENCE_BITS[code]);
  });

  it("is well formed: 11 modules (13 for stop), bar first, three bars, no duplicates", () => {
    const seen = new Set<string>();
    for (let code = 0; code <= 106; code++) {
      const m = patternModules(code);
      expect(m).toHaveLength(code === 106 ? 13 : 11);
      expect(m.startsWith("1")).toBe(true);
      // A symbol character is bar,space,bar,space,bar,space (ends with a space);
      // only the stop pattern has a 7th element, a final bar.
      expect(m.endsWith(code === 106 ? "1" : "0")).toBe(true);
      expect(m.match(/1+/g)).toHaveLength(code === 106 ? 4 : 3);
      expect(seen.has(m)).toBe(false);
      seen.add(m);
    }
  });

  it("refuses a code outside the table", () => {
    expect(() => patternModules(107)).toThrow(RangeError);
    expect(() => patternModules(-1)).toThrow(RangeError);
  });
});

describe("mod-103 check character", () => {
  it("matches the worked example 'PJJ123C' in code set A (Wikipedia: 54)", () => {
    // Start A (103), then P J J 1 2 3 C = ASCII - 32.
    expect(code128Checksum([103, 48, 42, 42, 17, 18, 19, 35])).toBe(54);
  });

  it("weights each data code by its position, FNC1 included", () => {
    // 105 + 102*1 + 0*2 + 34*3 + 1*4 + 23*5 + 45*6 + 0*7 + 0*8 + 0*9 + 0*10 + 17*11 = 885 = 8*103 + 61
    expect(code128Checksum([105, 102, 0, 34, 1, 23, 45, 0, 0, 0, 0, 17])).toBe(61);
  });
});

describe("Code 128 set B", () => {
  it("encodes 'LPN-01HZ' to the exact symbol pattern", () => {
    const s = encodeCode128B("LPN-01HZ");
    // 104 + 44*1 + 48*2 + 46*3 + 13*4 + 16*5 + 17*6 + 40*7 + 58*8 = 1360 = 13*103 + 21
    expect(s.codes).toEqual([104, 44, 48, 46, 13, 16, 17, 40, 58, 21]);
    expect(s.checksum).toBe(21);
    expect(s.modules).toBe(
      "110100100001000110111011101110110101110001101001101110010011101100100111001101100010100011101100010110111001001100011101011",
    );
    expect(s.modules).toHaveLength(11 * 10 + 13);
  });

  it("encodes a single space and the printable extremes, and refuses what set B cannot hold", () => {
    expect(encodeCode128B(" ~").codes).toEqual([104, 0, 94, (104 + 94 * 2) % 103]);
    expect(() => encodeCode128B("")).toThrow(RangeError);
    expect(() => encodeCode128B("tab\there")).toThrow(RangeError);
    expect(() => encodeCode128B("é")).toThrow(RangeError);
    expect(() => encodeCode128B("\u007f")).toThrow(RangeError);
  });

  it("decodes back to the text for every printable ASCII character", () => {
    let all = "";
    for (let cp = 0x20; cp <= 0x7e; cp++) all += String.fromCharCode(cp);
    expect(decodeModules(encodeCode128B(all).modules).text).toBe(all);
  });
});

describe("GS1-128 SSCC", () => {
  it("encodes (00)340123450000000017 to the exact symbol pattern: Start C, FNC1, ten pairs, check, stop", () => {
    const s = encodeGs1128Sscc(SSCC);
    expect(s.data).toBe(`00${SSCC}`);
    expect(s.codes).toEqual([105, 102, 0, 34, 1, 23, 45, 0, 0, 0, 0, 17, 61]);
    expect(s.modules).toBe(
      "110100111001111010111011011001100100010110001100110110011101101110101110110001101100110011011001100110110011001101100110010011100110110010000101100011101011",
    );
    expect(s.modules).toHaveLength(11 * 13 + 13);
  });

  it("is Start C + FNC1 on the wire (FNC1 straight after the start marks GS1-128)", () => {
    const m = encodeGs1128Sscc(SSCC).modules;
    expect(m.startsWith(REFERENCE_BITS[105] as string)).toBe(true);
    expect(m.slice(11, 22)).toBe(REFERENCE_BITS[102]);
    expect(decodeModules(m).gs1).toBe(true);
  });

  it("refuses a wrong length, non-digits and a wrong check digit", () => {
    expect(() => encodeGs1128Sscc("34012345000000001")).toThrow(RangeError);
    expect(() => encodeGs1128Sscc("3401234500000000170")).toThrow(RangeError);
    expect(() => encodeGs1128Sscc("34012345000000001X")).toThrow(RangeError);
    expect(() => encodeGs1128Sscc("340123450000000018")).toThrow(/check digit/);
  });
});

describe("scan what you print (decoder -> the scan flow's own GS1 parser)", () => {
  it("an SSCC printed as GS1-128 resolves to the same SSCC, bare and with the ]C1 identifier", () => {
    const decoded = decodeModules(encodeGs1128Sscc(SSCC).modules);
    expect(decoded.gs1).toBe(true);
    expect(decoded.text).toBe(`00${SSCC}`);
    for (const wedge of [decoded.text, `]C1${decoded.text}`, `]C1${decoded.text}${GS}`]) {
      const parsed = parseScan(wedge);
      expect(parsed.kind, wedge).toBe("SSCC");
      expect(parsed.kind === "SSCC" && parsed.sscc).toBe(SSCC);
    }
  });

  it("the human-readable text with AI brackets resolves to the same SSCC too", () => {
    const parsed = parseScan(`(00)${SSCC}`);
    expect(parsed).toMatchObject({ kind: "SSCC", sscc: SSCC });
  });

  it("an internal LPN printed as Code 128 decodes to the LPN byte for byte", () => {
    const decoded = decodeModules(encodeCode128B(LPN).modules);
    expect(decoded.gs1).toBe(false);
    expect(decoded.text).toBe(LPN);
  });

  it("FINDING: the receiving scan parser does not know an LPN (stow must read it as its own token)", () => {
    // parseScan is the GS1 parser of the scan flow: LPN-<ulid> is not a GS1 key, so it is INVALID
    // there (not-digits), never mistaken for an SSCC or GTIN. Resolving an LPN is the stow flow's job.
    expect(parseScan(LPN)).toMatchObject({ kind: "INVALID", reason: "not-digits" });
  });
});

describe("label barcode selection", () => {
  it("SSCC -> GS1-128 at 0.5 mm, with the grouped human-readable text", () => {
    const b = labelBarcodeFor(SSCC);
    expect(b?.symbol.kind).toBe("GS1_128");
    expect(b?.moduleMm).toBe(0.5);
    expect(b?.humanReadable).toBe("(00) 3 4012345 000000001 7");
    expect(formatSsccHumanReadable(SSCC).replace(/[() ]/g, "")).toBe(`00${SSCC}`);
  });

  it("internal LPN -> Code 128 B at 0.25 mm, text is the LPN, and the symbol fits a 100 mm label", () => {
    const b = labelBarcodeFor(LPN);
    expect(b?.symbol.kind).toBe("CODE128B");
    expect(b?.humanReadable).toBe(LPN);
    const { totalModules } = barRuns((b as NonNullable<typeof b>).symbol);
    expect(totalModules * (b as NonNullable<typeof b>).moduleMm).toBeLessThanOrEqual(100);
  });

  it("the SSCC symbol with quiet zones fits a 100 mm label at 0.5 mm", () => {
    const b = labelBarcodeFor(SSCC);
    const { totalModules } = barRuns((b as NonNullable<typeof b>).symbol);
    expect(totalModules).toBe(156 + 2 * QUIET_ZONE_MODULES);
    expect(totalModules * 0.5).toBeLessThanOrEqual(100);
  });

  it("draws nothing for a plate it cannot encode (bad SSCC check digit, other text, empty)", () => {
    for (const bad of ["340123450000000018", "12345", "", "carton 7", "LPN-", "LPN-é"]) expect(labelBarcodeFor(bad), bad).toBeNull();
  });
});

describe("bar runs", () => {
  it("are the 1-runs of the modules, shifted by the quiet zone, and never touch the edges", () => {
    const s = encodeCode128B("A");
    const { bars, totalModules } = barRuns(s);
    expect(totalModules).toBe(s.modules.length + 2 * QUIET_ZONE_MODULES);
    expect(bars[0]?.x).toBe(QUIET_ZONE_MODULES);
    const last = bars[bars.length - 1] as { x: number; width: number };
    expect(last.x + last.width).toBe(totalModules - QUIET_ZONE_MODULES);
    // Rebuild the module string from the runs: identical to what was encoded.
    let rebuilt = "";
    let pos = QUIET_ZONE_MODULES;
    for (const b of bars) {
      rebuilt += "0".repeat(b.x - pos) + "1".repeat(b.width);
      pos = b.x + b.width;
    }
    expect(rebuilt).toBe(s.modules);
  });
});
