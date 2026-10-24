import { describe, expect, it } from "vitest";
import { computeCheckDigit, hasValidCheckDigit, parseExpiry, parseScan, toPickGtin } from "./index";

const GS = "\u001d";
// Real strings, check digits computed with the GS1 mod-10 algorithm.
const CASE_GTIN14 = "13041090004824"; // indicator 1: the case of EACH
const EACH_GTIN14 = "03041090004827"; // = EAN-13 3041090004827
const EAN13 = "4006381333931";
const EAN8 = "96385074";
const UPCA = "042100005264";
const SSCC = "340123450000000017";
const SSCC2 = "340123456000000026";
const NOW = Date.UTC(2026, 9, 24);

describe("check digit", () => {
  it("computes GS1 mod-10 over GTIN-8/12/13/14 and SSCC-18", () => {
    expect(computeCheckDigit("1304109000482")).toBe(4);
    expect(computeCheckDigit("0304109000482")).toBe(7);
    expect(computeCheckDigit("400638133393")).toBe(1);
    expect(computeCheckDigit("9638507")).toBe(4);
    expect(computeCheckDigit("04210000526")).toBe(4);
    expect(computeCheckDigit("34012345000000001")).toBe(7);
  });
  it("validates and rejects", () => {
    for (const ok of [CASE_GTIN14, EACH_GTIN14, EAN13, EAN8, UPCA, SSCC, SSCC2]) expect(hasValidCheckDigit(ok)).toBe(true);
    expect(hasValidCheckDigit("13041090004825")).toBe(false);
    expect(hasValidCheckDigit("")).toBe(false);
    expect(hasValidCheckDigit("7")).toBe(false);
    expect(hasValidCheckDigit("12a4")).toBe(false);
  });
});

describe("parseScan: GTIN", () => {
  it("reads bare digits of 8, 12, 13 and 14 and pads to 14", () => {
    expect(parseScan(EAN8)).toMatchObject({ kind: "GTIN", gtin: "00000096385074", format: "GTIN-8", symbology: "NONE" });
    expect(parseScan(UPCA)).toMatchObject({ kind: "GTIN", gtin: "00042100005264", format: "GTIN-12" });
    expect(parseScan(EAN13)).toMatchObject({ kind: "GTIN", gtin: "04006381333931", format: "GTIN-13" });
    expect(parseScan(CASE_GTIN14)).toMatchObject({ kind: "GTIN", gtin: CASE_GTIN14, format: "GTIN-14" });
    expect(parseScan("3041090004827")).toMatchObject({ kind: "GTIN", gtin: EACH_GTIN14 });
  });
  it("accepts ]E0 (EAN-13, UPC-A, 8-digit) and ]I1 (ITF-14)", () => {
    expect(parseScan(`]E0${EAN13}`)).toMatchObject({ kind: "GTIN", gtin: "04006381333931", symbology: "EAN" });
    expect(parseScan(`]E0${UPCA}`)).toMatchObject({ kind: "GTIN", gtin: "00042100005264", symbology: "EAN" });
    expect(parseScan(`]E0${EAN8}`)).toMatchObject({ kind: "GTIN", gtin: "00000096385074" });
    expect(parseScan(`]E4${EAN8}`)).toMatchObject({ kind: "GTIN", gtin: "00000096385074" });
    expect(parseScan(`]I1${CASE_GTIN14}`)).toMatchObject({ kind: "GTIN", gtin: CASE_GTIN14, symbology: "ITF14" });
  });
  it("the each-EAN and the case ITF-14 of the same product are different 14-digit ids", () => {
    const each = parseScan(`]E0${EAN13.replace(EAN13, "3041090004827")}`);
    const kase = parseScan(`]I1${CASE_GTIN14}`);
    expect(each).toMatchObject({ gtin: EACH_GTIN14 });
    expect(kase).toMatchObject({ gtin: CASE_GTIN14 });
  });
  it("reads a GTIN-only GS1-128 as a GTIN", () => {
    expect(parseScan(`]C101${CASE_GTIN14}`)).toEqual({ kind: "GTIN", gtin: CASE_GTIN14, symbology: "GS1_128", format: "GTIN-14" });
  });
  it("refuses a bad check digit, a wrong length, non-digits and variable measure", () => {
    expect(parseScan("13041090004825")).toMatchObject({ kind: "INVALID", reason: "bad-check-digit" });
    expect(parseScan(`]E0${EAN13.slice(0, 12)}0`)).toMatchObject({ kind: "INVALID", reason: "bad-check-digit" });
    expect(parseScan("123456789")).toMatchObject({ kind: "INVALID", reason: "bad-length" });
    expect(parseScan(`]I1${EAN13}`)).toMatchObject({ kind: "INVALID", reason: "bad-length" });
    expect(parseScan(`]E0${CASE_GTIN14}`)).toMatchObject({ kind: "INVALID", reason: "bad-length" });
    expect(parseScan("]E04006381ABC931")).toMatchObject({ kind: "INVALID", reason: "not-digits" });
    expect(parseScan("ORD-42")).toMatchObject({ kind: "INVALID", reason: "not-digits" });
    // indicator digit 9 = variable measure (G7)
    expect(parseScan("93041090004820")).toMatchObject({ kind: "INVALID", reason: "variable-measure" });
  });
  it("refuses empty, oversized and unknown-symbology input without throwing", () => {
    expect(parseScan("")).toMatchObject({ kind: "INVALID", reason: "empty" });
    expect(parseScan("]C1")).toMatchObject({ kind: "INVALID", reason: "empty" });
    expect(parseScan("1".repeat(129))).toMatchObject({ kind: "INVALID", reason: "too-long" });
    expect(parseScan(`]Q1${EAN13}`)).toMatchObject({ kind: "INVALID", reason: "unknown-symbology" });
    expect(parseScan(`]d2${EAN13}`)).toMatchObject({ kind: "INVALID", reason: "unknown-symbology" });
  });
});

describe("parseScan: SSCC", () => {
  it("reads 18 bare digits and a lone AI 00", () => {
    expect(parseScan(SSCC)).toEqual({ kind: "SSCC", sscc: SSCC, symbology: "NONE" });
    expect(parseScan(`]C100${SSCC}`)).toEqual({ kind: "SSCC", sscc: SSCC, symbology: "GS1_128" });
    expect(parseScan(`(00)${SSCC}`)).toMatchObject({ kind: "SSCC", sscc: SSCC });
  });
  it("validates the SSCC check digit", () => {
    expect(parseScan("340123450000000018")).toMatchObject({ kind: "INVALID", reason: "bad-check-digit" });
    expect(parseScan("]C10034012345000000001")).toMatchObject({ kind: "INVALID", reason: "truncated-element" });
    expect(parseScan(`]C100340123450000000018`)).toMatchObject({ kind: "INVALID", reason: "bad-check-digit" });
  });
});

describe("parseScan: GS1-128 element strings with GS", () => {
  it("terminates a variable-length lot at GS and reads the AI after it", () => {
    const r = parseScan(`]C101${CASE_GTIN14}10LOT-A1B2${GS}17261231`, { now: NOW });
    expect(r).toEqual({
      kind: "GS1_ELEMENTS",
      symbology: "GS1_128",
      elements: {
        gtin: CASE_GTIN14,
        lot: "LOT-A1B2",
        expiry: { raw: "261231", date: "2026-12-31", endOfMonth: false },
      },
    });
  });
  it("without GS the lot swallows what follows (why normalizeScan must keep GS)", () => {
    const r = parseScan(`]C101${CASE_GTIN14}10LOT-A1B217261231`, { now: NOW });
    expect(r).toMatchObject({ kind: "GS1_ELEMENTS", elements: { lot: "LOT-A1B217261231" } });
  });
  it("lot last needs no terminator; a trailing GS is tolerated; fixed AIs need no GS", () => {
    expect(parseScan(`]C101${CASE_GTIN14}17261231${"10"}B7`, { now: NOW })).toMatchObject({
      elements: { gtin: CASE_GTIN14, lot: "B7", expiry: { date: "2026-12-31" } },
    });
    expect(parseScan(`]C101${CASE_GTIN14}10B7${GS}`)).toMatchObject({ elements: { lot: "B7" } });
  });
  it("accepts a 20-char lot and refuses 21", () => {
    const lot20 = "ABCDEFGHIJ0123456789";
    expect(parseScan(`]C101${CASE_GTIN14}10${lot20}`)).toMatchObject({ elements: { lot: lot20 } });
    expect(parseScan(`]C101${CASE_GTIN14}10${lot20}X`)).toMatchObject({ kind: "INVALID", reason: "bad-lot" });
    expect(parseScan(`]C101${CASE_GTIN14}10${GS}17261231`)).toMatchObject({ kind: "INVALID", reason: "bad-lot" });
  });
  it("reads a logistic label: SSCC + content GTIN (02) + count (37) + lot + expiry", () => {
    const r = parseScan(`]C100${SSCC}02${EACH_GTIN14}3700012${GS}10L9${GS}17270600`, { now: NOW });
    expect(r).toEqual({
      kind: "GS1_ELEMENTS",
      symbology: "GS1_128",
      elements: {
        sscc: SSCC,
        contentGtin: EACH_GTIN14,
        count: 12,
        lot: "L9",
        expiry: { raw: "270600", date: "2027-06-30", endOfMonth: true },
      },
    });
  });
  it("reads AI 37 as variable length ended by GS", () => {
    const r = parseScan(`]C100${SSCC2}02${CASE_GTIN14}376${GS}10X`);
    expect(r).toMatchObject({ elements: { sscc: SSCC2, contentGtin: CASE_GTIN14, count: 6, lot: "X" } });
  });
  it("reads the human-readable (01)(10) form typed by hand", () => {
    expect(parseScan(`(01)${CASE_GTIN14}(10)LOT-1(17)261231`, { now: NOW })).toMatchObject({
      kind: "GS1_ELEMENTS",
      elements: { gtin: CASE_GTIN14, lot: "LOT-1", expiry: { date: "2026-12-31" } },
    });
    expect(parseScan(`(01)${CASE_GTIN14}`)).toMatchObject({ kind: "GTIN", gtin: CASE_GTIN14 });
  });
  it("reads an element string whose scanner stripped the ]C1 prefix", () => {
    expect(parseScan(`01${CASE_GTIN14}10L${GS}17261231`)).toMatchObject({ kind: "GS1_ELEMENTS", elements: { gtin: CASE_GTIN14, lot: "L" } });
  });
});

describe("parseScan: element-string rules", () => {
  it("never allows AI 01 together with AI 02", () => {
    expect(parseScan(`]C101${CASE_GTIN14}02${EACH_GTIN14}`)).toMatchObject({ kind: "INVALID", reason: "gtin-and-content-gtin" });
  });
  it("AI 02 requires AI 00 and AI 37", () => {
    expect(parseScan(`]C102${EACH_GTIN14}3712`)).toMatchObject({ kind: "INVALID", reason: "content-gtin-requires-sscc" });
    expect(parseScan(`]C100${SSCC}02${EACH_GTIN14}`)).toMatchObject({ kind: "INVALID", reason: "content-gtin-requires-count" });
  });
  it("refuses repeated AIs, unknown AIs and truncated values", () => {
    expect(parseScan(`]C110A${GS}10B`)).toMatchObject({ kind: "INVALID", reason: "duplicate-ai" });
    expect(parseScan(`]C191ABC`)).toMatchObject({ kind: "INVALID", reason: "unsupported-ai" });
    expect(parseScan(`]C101${CASE_GTIN14.slice(0, 10)}`)).toMatchObject({ kind: "INVALID", reason: "truncated-element" });
    expect(parseScan(`]C101${CASE_GTIN14}17`)).toMatchObject({ kind: "INVALID", reason: "truncated-element" });
    expect(parseScan(`(99)123`)).toMatchObject({ kind: "INVALID", reason: "unsupported-ai" });
    expect(parseScan(`(01)${CASE_GTIN14}junk`)).toMatchObject({ kind: "INVALID", reason: "bad-element-value" });
  });
  it("validates every check digit and the numeric AIs", () => {
    expect(parseScan(`]C101${CASE_GTIN14.slice(0, 13)}5`)).toMatchObject({ kind: "INVALID", reason: "bad-check-digit" });
    expect(parseScan(`]C100${SSCC}02${EACH_GTIN14.slice(0, 13)}0376`)).toMatchObject({ kind: "INVALID", reason: "bad-check-digit" });
    expect(parseScan(`]C101${CASE_GTIN14}37${GS}`)).toMatchObject({ kind: "INVALID", reason: "bad-element-value" });
    expect(parseScan(`]C100${SSCC}02${EACH_GTIN14}370`)).toMatchObject({ kind: "INVALID", reason: "bad-element-value" });
    expect(parseScan(`]C100${SSCC}02${EACH_GTIN14}37123456789`)).toMatchObject({ kind: "INVALID", reason: "bad-element-value" });
    expect(parseScan(`]C101${CASE_GTIN14}17ABCDEF`)).toMatchObject({ kind: "INVALID", reason: "bad-element-value" });
  });
  it("refuses a variable-measure GTIN-14 in AI 01", () => {
    expect(parseScan("]C10193041090004820")).toMatchObject({ kind: "INVALID", reason: "variable-measure" });
  });
  it("refuses a lot with spaces or control characters", () => {
    expect(parseScan(`]C101${CASE_GTIN14}10A B`)).toMatchObject({ kind: "INVALID", reason: "bad-lot" });
  });
});

describe("expiry (AI 17)", () => {
  it("reads a plain date", () => {
    expect(parseExpiry("261231", NOW)).toEqual({ raw: "261231", date: "2026-12-31", endOfMonth: false });
  });
  it("day 00 is the last day of the month, leap years included", () => {
    expect(parseExpiry("270200", NOW)?.date).toBe("2027-02-28");
    expect(parseExpiry("280200", NOW)?.date).toBe("2028-02-29");
    expect(parseExpiry("261100", NOW)?.date).toBe("2026-11-30");
    expect(parseExpiry("261200", NOW)).toMatchObject({ date: "2026-12-31", endOfMonth: true });
  });
  it("refuses impossible months and days", () => {
    expect(parseExpiry("261301", NOW)).toBeNull();
    expect(parseExpiry("260001", NOW)).toBeNull();
    expect(parseExpiry("270229", NOW)).toBeNull();
    expect(parseExpiry("260431", NOW)).toBeNull();
    expect(parseExpiry("26123", NOW)).toBeNull();
    expect(parseExpiry("26AB31", NOW)).toBeNull();
  });
  it("picks the century with the GS1 50-year window", () => {
    expect(parseExpiry("301231", NOW)?.date).toBe("2030-12-31");
    expect(parseExpiry("761231", NOW)?.date).toBe("2076-12-31");
    expect(parseExpiry("771231", NOW)?.date).toBe("1977-12-31");
    expect(parseExpiry("991231", NOW)?.date).toBe("1999-12-31");
    expect(parseExpiry("010101", NOW)?.date).toBe("2001-01-01");
  });
  it("a bad AI 17 in an element string is INVALID(bad-expiry)", () => {
    expect(parseScan(`]C101${CASE_GTIN14}17261331`)).toMatchObject({ kind: "INVALID", reason: "bad-expiry" });
  });
});

describe("toPickGtin", () => {
  it("takes the GTIN of a GTIN or of a GS1-128 with AI 01, ignoring lot, expiry and AI 37", () => {
    expect(toPickGtin(parseScan(EAN13))).toEqual({ ok: true, gtin: "04006381333931" });
    expect(toPickGtin(parseScan(`]C101${CASE_GTIN14}3706${GS}10L`))).toEqual({ ok: true, gtin: CASE_GTIN14 });
  });
  it("refuses an SSCC and a logistic label (02), and passes the INVALID reason on", () => {
    expect(toPickGtin(parseScan(SSCC))).toEqual({ ok: false, reason: "sscc" });
    expect(toPickGtin(parseScan(`]C100${SSCC}02${EACH_GTIN14}3712`))).toEqual({ ok: false, reason: "content-label" });
    expect(toPickGtin(parseScan(`]C110LOT`))).toEqual({ ok: false, reason: "no-gtin" });
    expect(toPickGtin(parseScan("13041090004825"))).toEqual({ ok: false, reason: "bad-check-digit" });
  });
});
