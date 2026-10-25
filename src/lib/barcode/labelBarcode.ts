import { encodeCode128B, encodeGs1128Sscc, type Code128Symbol } from "./code128";

/** Quiet zone each side, in modules (ISO/IEC 15417 and GS1 General Specifications: at least 10X). */
export const QUIET_ZONE_MODULES = 10;

/** Narrowest bar, in mm. 0.495 mm is the GS1 minimum for a logistic label (SSCC); an LPN is 30 characters, so it needs a finer bar to fit a 100 mm label (385 modules x 0.25 mm = 96 mm). */
export const SSCC_MODULE_MM = 0.5;
export const LPN_MODULE_MM = 0.25;

/** `LPN-<ULID>`: what inbound-receiving mints for a carton received without an SSCC. Kept loose (printable ASCII) on purpose: the service owns the exact format. */
const LPN_FORM = /^LPN-[\x21-\x7e]{1,59}$/;

export interface LabelBarcode {
  symbol: Code128Symbol;
  /** Bar width in mm: sets the printed size (symbol width x module width). */
  moduleMm: number;
  /** The text printed under the bars. */
  humanReadable: string;
}

/**
 * `(00) 3 4012345 000000001 7`: the SSCC as the GS1 General Specifications show it for people,
 * with the AI in brackets. The groups are only for reading (extension digit, 7-digit company
 * prefix, serial reference, check digit) and carry no data: the barcode holds the 18 digits.
 */
export function formatSsccHumanReadable(sscc: string): string {
  return `(00) ${sscc.slice(0, 1)} ${sscc.slice(1, 8)} ${sscc.slice(8, 17)} ${sscc.slice(17)}`;
}

/**
 * Picks the symbol for a carton's license plate: an 18-digit SSCC becomes GS1-128, an internal
 * `LPN-...` becomes Code 128 set B. Anything else (including an SSCC with a wrong check digit)
 * is `null`: print no barcode rather than one a scanner would misread or the stow flow reject.
 */
export function labelBarcodeFor(lpn: string): LabelBarcode | null {
  try {
    if (/^\d{18}$/.test(lpn)) {
      return { symbol: encodeGs1128Sscc(lpn), moduleMm: SSCC_MODULE_MM, humanReadable: formatSsccHumanReadable(lpn) };
    }
    if (LPN_FORM.test(lpn)) {
      return { symbol: encodeCode128B(lpn), moduleMm: LPN_MODULE_MM, humanReadable: lpn };
    }
  } catch {
    return null;
  }
  return null;
}

export interface BarRun {
  /** In modules from the left edge of the quiet zone. */
  x: number;
  width: number;
}

/** The bars of a symbol as runs, offset by the quiet zone; `totalModules` includes both quiet zones. */
export function barRuns(symbol: Code128Symbol): { bars: BarRun[]; totalModules: number } {
  const bars: BarRun[] = [];
  const m = symbol.modules;
  let i = 0;
  while (i < m.length) {
    let j = i;
    while (j < m.length && m[j] === m[i]) j++;
    if (m[i] === "1") bars.push({ x: QUIET_ZONE_MODULES + i, width: j - i });
    i = j;
  }
  return { bars, totalModules: m.length + 2 * QUIET_ZONE_MODULES };
}
