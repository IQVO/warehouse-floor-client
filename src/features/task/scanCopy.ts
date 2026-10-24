import type { PickGtin } from "../../lib/gs1";

type Refusal = Extract<PickGtin, { ok: false }>["reason"];

/**
 * What to tell the operator when a scan is not usable as an item or case
 * barcode (caught here, before any request). Machine reasons come from the
 * GS1 parser; the words live here.
 */
export function describePickRefusal(reason: Refusal): string {
  switch (reason) {
    case "sscc":
      return "That is a carton (SSCC) label, not an item or case barcode. Scan the barcode on the item or on the case.";
    case "content-label":
      return "That is a pallet or mixed-carton label. Scan the barcode on the item or on the case.";
    case "no-gtin":
      return "That label has no product code. Scan the barcode on the item or on the case.";
    case "bad-check-digit":
      return "That barcode was misread (its check digit does not match). Scan it again.";
    case "variable-measure":
      return "Weight-priced items cannot be scanned here. Ask your lead.";
    case "too-long":
      return "That scan is too long to be a barcode. Scan again.";
    case "bad-lot":
    case "bad-expiry":
    case "bad-element-value":
    case "truncated-element":
    case "malformed-element-string":
    case "duplicate-ai":
    case "unsupported-ai":
    case "gtin-and-content-gtin":
    case "content-gtin-requires-sscc":
    case "content-gtin-requires-count":
      return "That label could not be read. Scan it again, or scan the plain item barcode.";
    default:
      return "That is not an item or case barcode. Scan it again.";
  }
}
