import { parseScan, type ParsedScan } from "../../lib/gs1";
import type { ScanKind, ScanRequest } from "../../api/inboundReceiving";

/** The counting mode the operator picked: what the next scan is expected to be. */
export type Mode = "carton" | "case" | "each";

export const MODE_KIND: Record<Mode, ScanKind> = { carton: "SSCC", case: "CASE_GTIN", each: "EACH_GTIN" };

export interface AuditLine {
  sku: string;
  qty: string;
}

export type Built = { ok: true; request: ScanRequest } | { ok: false; message: string };

export const MAX_CASES = 1000;

function refusal(parsed: Extract<ParsedScan, { kind: "INVALID" }>): string {
  switch (parsed.reason) {
    case "bad-check-digit":
      return "That barcode was misread (its check digit does not match). Scan it again.";
    case "variable-measure":
      return "Weight-priced items cannot be received here. Set them aside and ask your lead.";
    case "too-long":
      return "That scan is too long to be a barcode. Scan again.";
    default:
      return "That barcode could not be read. Scan it again.";
  }
}

/**
 * Turns one raw scan into the request body, before any network. The
 * parser only decides WHAT was scanned (SSCC / GTIN-14, lot, expiry); the
 * operator's mode decides whether a GTIN is a case or an each, and the
 * server re-validates both. The count is sent as typed: for a case GTIN it
 * counts CASES and the server multiplies (contract R7): nothing here ever
 * multiplies.
 */
export function buildScanRequest(raw: string, mode: Mode, count: number, audit: AuditLine[]): Built {
  const parsed = parseScan(raw);
  if (parsed.kind === "INVALID") return { ok: false, message: refusal(parsed) };

  let sscc: string | undefined;
  let gtin: string | undefined;
  let lot: string | undefined;
  let expiry: string | undefined;
  if (parsed.kind === "SSCC") sscc = parsed.sscc;
  else if (parsed.kind === "GTIN") gtin = parsed.gtin;
  else {
    sscc = parsed.elements.sscc;
    gtin = parsed.elements.gtin;
    lot = parsed.elements.lot;
    expiry = parsed.elements.expiry?.date;
  }

  if (mode === "carton") {
    if (sscc === undefined) {
      return { ok: false, message: "That is an item or case barcode, not a carton label. Choose Cases or Items above, or scan the carton label." };
    }
    const counted = audit.filter((l) => l.sku.trim() !== "");
    const bad = counted.find((l) => !/^\d+$/.test(l.qty.trim()));
    if (bad !== undefined) return { ok: false, message: `Enter the counted quantity for ${bad.sku.trim()} (a whole number, 0 or more).` };
    return {
      ok: true,
      request: {
        kind: "SSCC",
        id: sscc,
        ...(counted.length > 0 ? { countedContents: counted.map((l) => ({ sku: l.sku.trim(), qty: Number(l.qty.trim()) })) } : {}),
      },
    };
  }

  if (gtin === undefined) {
    return {
      ok: false,
      message:
        sscc !== undefined
          ? "That is a carton label, not an item or case barcode. Choose Carton above, or scan the barcode on the case or item."
          : "That label has no product code. Scan the barcode on the case or item.",
    };
  }
  if (!Number.isInteger(count) || count < 1) return { ok: false, message: "Enter how many you are scanning (a whole number, 1 or more)." };
  if (mode === "case" && count > MAX_CASES) return { ok: false, message: `At most ${MAX_CASES} cases can be counted at once.` };
  return {
    ok: true,
    request: {
      kind: MODE_KIND[mode],
      id: gtin,
      qty: count,
      ...(lot === undefined ? {} : { lot }),
      ...(expiry === undefined ? {} : { expiry }),
    },
  };
}
