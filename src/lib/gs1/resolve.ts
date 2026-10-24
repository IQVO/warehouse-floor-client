import type { InvalidReason, ParsedScan } from "./types";

/** What a PICK scan sends: the 14-digit GTIN. The count is always 1 per scan and never comes from the label. */
export type PickGtin =
  | { ok: true; gtin: string }
  | { ok: false; reason: InvalidReason | "sscc" | "no-gtin" | "content-label" };

/**
 * Resolves a parsed scan for a screen that expects an each or case GTIN (the
 * PICK scan-confirm). Whether it is the each or the case level is the
 * server's call (it owns the pack levels): the client only refuses what is
 * not a GTIN at all.
 *
 * An AI 37 count on the label is deliberately ignored. It counts units inside
 * the carton; the server multiplies cases by the pack factor, the client never
 * sends a quantity with a new meaning (contract R13).
 */
export function toPickGtin(parsed: ParsedScan): PickGtin {
  switch (parsed.kind) {
    case "GTIN":
      return { ok: true, gtin: parsed.gtin };
    case "INVALID":
      return { ok: false, reason: parsed.reason };
    case "SSCC":
      return { ok: false, reason: "sscc" };
    case "GS1_ELEMENTS": {
      const e = parsed.elements;
      if (e.gtin !== undefined) return { ok: true, gtin: e.gtin };
      if (e.contentGtin !== undefined) return { ok: false, reason: "content-label" };
      if (e.sscc !== undefined) return { ok: false, reason: "sscc" };
      return { ok: false, reason: "no-gtin" };
    }
  }
}
