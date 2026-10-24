/** What a scan resolved to. A pure value: no network, no clock unless `parseScan` is handed one. */
export type Symbology = "EAN" | "ITF14" | "GS1_128" | "NONE";

/** The machine reason on an INVALID result. Screens map these to words; the parser never builds copy. */
export type InvalidReason =
  | "empty"
  | "too-long"
  | "unknown-symbology"
  | "not-digits"
  | "bad-length"
  | "bad-check-digit"
  | "variable-measure"
  | "symbology-mismatch"
  | "malformed-element-string"
  | "unsupported-ai"
  | "duplicate-ai"
  | "truncated-element"
  | "bad-element-value"
  | "bad-lot"
  | "bad-expiry"
  | "gtin-and-content-gtin"
  | "content-gtin-requires-sscc"
  | "content-gtin-requires-count";

/** AI 17 as scanned and as a calendar date. Day 00 on the label means the last day of that month. */
export interface Expiry {
  /** The six digits as printed, YYMMDD. */
  raw: string;
  /** ISO calendar date, with day 00 resolved to the month's last day. */
  date: string;
  /** True when the label said day 00. */
  endOfMonth: boolean;
}

/** The AIs this client reads; any other AI makes the scan INVALID (unsupported-ai) because its length is unknown. */
export interface Gs1Elements {
  /** AI 00, 18 digits. */
  sscc?: string;
  /** AI 01, 14 digits. */
  gtin?: string;
  /** AI 02, 14 digits (GTIN of the units inside a logistic unit). Always together with `sscc` and `count`. */
  contentGtin?: string;
  /** AI 37, count of contained units. Informational: never sent as a quantity (the server multiplies). */
  count?: number;
  /** AI 10. */
  lot?: string;
  /** AI 17. */
  expiry?: Expiry;
}

export type ParsedScan =
  | { kind: "SSCC"; sscc: string; symbology: Symbology }
  /** `gtin` is always the 14-digit zero-left-padded form. `format` is how it was printed. */
  | { kind: "GTIN"; gtin: string; symbology: Symbology; format: "GTIN-8" | "GTIN-12" | "GTIN-13" | "GTIN-14" }
  /** A GS1-128 element string with more than a lone SSCC or GTIN in it. */
  | { kind: "GS1_ELEMENTS"; elements: Gs1Elements; symbology: "GS1_128" }
  | { kind: "INVALID"; reason: InvalidReason; input: string };
