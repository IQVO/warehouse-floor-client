import { hasValidCheckDigit } from "./checkDigit";
import type { Expiry, Gs1Elements, InvalidReason, ParsedScan, Symbology } from "./types";

/** ASCII Group Separator: what a scanner emits for FNC1 inside a GS1-128 element string. */
export const GS = "\u001d";

const MAX_INPUT = 128;
const MAX_LOT = 20;
const MAX_COUNT_DIGITS = 8;

/** GS1 AI encodable set 82, minus the space: printable ASCII 0x21..0x7E. */
const LOT_CHARS = /^[\u0021-\u007e]+$/;

/** AI -> fixed digit length, or a variable max. Only the AIs this client reads. */
const AI_TABLE: Record<string, { fixed: number } | { max: number; numeric: boolean }> = {
  "00": { fixed: 18 },
  "01": { fixed: 14 },
  "02": { fixed: 14 },
  "10": { max: MAX_LOT, numeric: false },
  "17": { fixed: 6 },
  "37": { max: MAX_COUNT_DIGITS, numeric: true },
};

function invalid(reason: InvalidReason, input: string): ParsedScan {
  return { kind: "INVALID", reason, input };
}

export interface ParseOptions {
  /** Epoch ms used to pick the century of AI 17's two-digit year. Defaults to now. */
  now?: number;
}

/**
 * Parses one scan into SSCC | GTIN | GS1_ELEMENTS | INVALID (contract R13).
 *
 * Accepts:
 *  - an AIM symbology identifier prefix: `]E0`/`]E4` (EAN-13, UPC-A, UPC-E/EAN-8
 *    as 8/12/13 digits), `]I1` (ITF-14), `]C1` (GS1-128 element string, FNC1
 *    as GS 0x1D). Other `]` prefixes are INVALID(unknown-symbology);
 *  - no prefix (most keyboard wedges strip it): 8, 12, 13 or 14 digits = GTIN,
 *    18 digits = SSCC, `(01)...(10)...` human-readable form, or a raw element
 *    string when it starts with a known AI and holds one;
 *  - GS-separated GS1-128 element strings.
 *
 * Every GTIN/SSCC check digit is validated (GS1 mod-10). A GTIN is returned as
 * 14 digits, zero-left-padded. Indicator digit 9 (variable measure) is refused.
 * Never throws.
 */
export function parseScan(raw: string, options: ParseOptions = {}): ParsedScan {
  if (raw === "") return invalid("empty", raw);
  if (raw.length > MAX_INPUT) return invalid("too-long", raw.slice(0, MAX_INPUT));

  let body = raw;
  let prefix: string | null = null;
  if (body.startsWith("]")) {
    prefix = body.slice(0, 3);
    body = body.slice(3);
  }
  if (prefix === null) body = trimTrailingGs(body);
  if (body === "") return invalid("empty", raw);

  switch (prefix) {
    case null:
      return parseUnprefixed(body, raw, options);
    case "]E0":
    case "]E4": {
      if (!/^\d+$/.test(body)) return invalid("not-digits", raw);
      if (![8, 12, 13].includes(body.length)) return invalid("bad-length", raw);
      return gtinFromDigits(body, "EAN", raw);
    }
    case "]I1": {
      if (!/^\d+$/.test(body)) return invalid("not-digits", raw);
      if (body.length !== 14) return invalid("bad-length", raw);
      return gtinFromDigits(body, "ITF14", raw);
    }
    case "]C1":
      return parseElementString(trimTrailingGs(body), raw, options);
    default:
      return invalid("unknown-symbology", raw);
  }
}

function parseUnprefixed(body: string, raw: string, options: ParseOptions): ParsedScan {
  if (/^\d+$/.test(body)) {
    if (body.length === 18) return ssccFromDigits(body, "NONE", raw);
    // A GS1-128 SSCC whose scanner stripped the ]C1 identifier: AI 00 + 18
    // digits. No GTIN has 20 digits, so this is unambiguous.
    if (body.length === 20 && body.startsWith("00")) return parseElementString(body, raw, options);
    if ([8, 12, 13, 14].includes(body.length)) return gtinFromDigits(body, "NONE", raw);
    return invalid("bad-length", raw);
  }
  if (body.startsWith("(") || body.includes(GS)) return parseElementString(body, raw, options);
  // A lot or other text with no GS can still be a GS1-128 string whose scanner
  // stripped the prefix: try it when it starts with a known AI.
  if (/^(00|01|02|10|17|37)/.test(body)) return parseElementString(body, raw, options);
  return invalid("not-digits", raw);
}

function trimTrailingGs(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === GS) end--;
  return s.slice(0, end);
}

function gtinFromDigits(digits: string, symbology: Symbology, input: string): ParsedScan {
  if (!hasValidCheckDigit(digits)) return invalid("bad-check-digit", input);
  const gtin = digits.padStart(14, "0");
  if (gtin[0] === "9") return invalid("variable-measure", input);
  const format = `GTIN-${digits.length}` as "GTIN-8" | "GTIN-12" | "GTIN-13" | "GTIN-14";
  return { kind: "GTIN", gtin, symbology, format };
}

function ssccFromDigits(digits: string, symbology: Symbology, input: string): ParsedScan {
  if (!hasValidCheckDigit(digits)) return invalid("bad-check-digit", input);
  return { kind: "SSCC", sscc: digits, symbology };
}

type Pair = { ai: string; value: string };

/** Splits an element string into AI/value pairs. Returns a reason string when it cannot. */
function splitElements(s: string): Pair[] | InvalidReason {
  const pairs: Pair[] = [];
  if (s.startsWith("(")) {
    // Human-readable form: (01)13041090004824(10)LOT. Brackets delimit, no GS needed.
    const re = /\((\d{2,4})\)([^(]*)/gy;
    let pos = 0;
    while (pos < s.length) {
      re.lastIndex = pos;
      const m = re.exec(s);
      if (m === null) return "malformed-element-string";
      const ai = m[1] ?? "";
      const value = (m[2] ?? "").split(GS).join("");
      const spec = AI_TABLE[ai];
      if (spec === undefined) return "unsupported-ai";
      pairs.push({ ai, value });
      pos = re.lastIndex;
    }
    return pairs;
  }

  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) {
      i++; // a stray separator after a fixed-length element is tolerated
      continue;
    }
    const ai = s.slice(i, i + 2);
    const spec = AI_TABLE[ai];
    if (spec === undefined) return "unsupported-ai";
    i += 2;
    if ("fixed" in spec) {
      if (i + spec.fixed > s.length) return "truncated-element";
      const value = s.slice(i, i + spec.fixed);
      if (value.includes(GS)) return "truncated-element";
      pairs.push({ ai, value });
      i += spec.fixed;
    } else {
      const end = s.indexOf(GS, i);
      const stop = end === -1 ? s.length : end;
      pairs.push({ ai, value: s.slice(i, stop) });
      i = stop;
    }
  }
  return pairs;
}

function parseElementString(s: string, input: string, options: ParseOptions): ParsedScan {
  if (s === "") return invalid("empty", input);
  const pairs = splitElements(s);
  if (typeof pairs === "string") return invalid(pairs, input);

  const elements: Gs1Elements = {};
  const seen = new Set<string>();
  for (const { ai, value } of pairs) {
    if (seen.has(ai)) return invalid("duplicate-ai", input);
    seen.add(ai);
    const spec = AI_TABLE[ai];
    if (spec === undefined) return invalid("unsupported-ai", input);
    if ("fixed" in spec) {
      if (value.length !== spec.fixed || !/^\d+$/.test(value)) return invalid("bad-element-value", input);
    } else if (spec.numeric) {
      if (value === "" || value.length > spec.max || !/^\d+$/.test(value)) return invalid("bad-element-value", input);
    }

    switch (ai) {
      case "00":
        if (!hasValidCheckDigit(value)) return invalid("bad-check-digit", input);
        elements.sscc = value;
        break;
      case "01":
      case "02": {
        if (!hasValidCheckDigit(value)) return invalid("bad-check-digit", input);
        if (value[0] === "9") return invalid("variable-measure", input);
        if (ai === "01") elements.gtin = value;
        else elements.contentGtin = value;
        break;
      }
      case "37":
        elements.count = Number(value);
        if (elements.count < 1) return invalid("bad-element-value", input);
        break;
      case "10":
        if (value === "" || value.length > MAX_LOT || !LOT_CHARS.test(value)) return invalid("bad-lot", input);
        elements.lot = value;
        break;
      case "17": {
        const expiry = parseExpiry(value, options.now ?? Date.now());
        if (expiry === null) return invalid("bad-expiry", input);
        elements.expiry = expiry;
        break;
      }
    }
  }

  // Combination rules (contract section 6): 01 and 02 never together; 02 needs 00 and 37.
  if (elements.gtin !== undefined && elements.contentGtin !== undefined) return invalid("gtin-and-content-gtin", input);
  if (elements.contentGtin !== undefined) {
    if (elements.sscc === undefined) return invalid("content-gtin-requires-sscc", input);
    if (elements.count === undefined) return invalid("content-gtin-requires-count", input);
  }

  const keys = Object.keys(elements);
  if (keys.length === 1 && elements.sscc !== undefined) return { kind: "SSCC", sscc: elements.sscc, symbology: "GS1_128" };
  if (keys.length === 1 && elements.gtin !== undefined) {
    return { kind: "GTIN", gtin: elements.gtin, symbology: "GS1_128", format: "GTIN-14" };
  }
  return { kind: "GS1_ELEMENTS", elements, symbology: "GS1_128" };
}

/**
 * AI 17 YYMMDD. Day 00 = last day of the month (GS1 General Specifications).
 * The century follows the GS1 rule: a year 51..99 ahead of the current one is
 * read as the past century, so 2-digit years never drift.
 */
export function parseExpiry(yymmdd: string, nowMs: number = Date.now()): Expiry | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) return null;

  const currentYear = new Date(nowMs).getUTCFullYear();
  let year = currentYear - (currentYear % 100) + yy;
  if (year - currentYear >= 51) year -= 100;
  else if (currentYear - year >= 50) year += 100;

  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  const endOfMonth = dd === 0;
  const day = endOfMonth ? lastDay : dd;
  if (day < 1 || day > lastDay) return null;
  const date = `${String(year).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { raw: yymmdd, date, endOfMonth };
}
