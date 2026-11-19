import { normalizeScan } from "../../lib/scan";
import { parseScan } from "../../lib/gs1";

export type YardCode = { ok: true; code: string } | { ok: false; message: string };

/** Longest code the API takes: Location.code 128, a unit number 64. */
const MAX_LEN = { location: 128, unit: 64 } as const;

/** Printable ASCII, spaces allowed inside (a painted unit number can read "ABCD 123456"). */
const CODE_CHARS = /^[\u0020-\u007e]+$/;

/**
 * Reads one scan of a yard location label (spot or door) or a trailer unit
 * number. The text goes through `parseScan` first, like every scan in this app:
 *
 *  - a GS1 product / carton label (GTIN, SSCC, element string) is NOT a yard
 *    label: it is refused, so a carton scanned by mistake never becomes a
 *    "door code";
 *  - an unreadable symbology prefix or an oversized blob is refused;
 *  - anything else `parseScan` calls INVALID simply is not GS1, which is what
 *    a facility-layout locationCode ("WH1-DOCK-IN-01") or a unit number is: it
 *    is used verbatim (trimmed, control characters stripped by `normalizeScan`).
 *
 * Consequence (documented in the README): a yard label that is only digits and
 * happens to be a valid GTIN or SSCC cannot be scanned.
 */
export function readYardCode(raw: string, what: "location" | "unit"): YardCode {
  const text = normalizeScan(raw);
  const noun = what === "location" ? "a spot or door label" : "a trailer unit number";
  if (text === "") return { ok: false, message: `That scan was empty or too long. Scan ${noun} again.` };

  const parsed = parseScan(text);
  switch (parsed.kind) {
    case "SSCC":
    case "GTIN":
    case "GS1_ELEMENTS":
      return { ok: false, message: `That is a product or carton barcode, not ${noun}. Scan ${noun}.` };
    case "INVALID":
      if (parsed.reason === "unknown-symbology" || parsed.reason === "too-long" || parsed.reason === "empty") {
        return { ok: false, message: `That barcode could not be read as ${noun}. Scan it again.` };
      }
      break;
  }
  if (!CODE_CHARS.test(text) || text.length > MAX_LEN[what]) {
    return { ok: false, message: `That does not look like ${noun}. Scan it again.` };
  }
  return { ok: true, code: text };
}
