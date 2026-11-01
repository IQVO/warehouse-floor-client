import { hasValidCheckDigit } from "../gs1";

/**
 * A small, pure Code 128 encoder (ISO/IEC 15417) for the two symbols the receiving
 * dock prints: Code 128 set B (the internal `LPN-<ulid>`) and GS1-128 (the 18-digit SSCC
 * as AI (00), which is Code 128 set C opened with FNC1 right after the start code).
 *
 * No DOM, no clock, no dependency: `string -> symbol codes -> modules`. A "module" is
 * the narrowest bar; `modules` is a string of `1` (bar) and `0` (space), one char each.
 */

/** Run lengths (bar, space, bar, space, bar, space) of symbol characters 0..105, then the stop pattern (7 elements). */
const PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

export const CODE_START_B = 104;
export const CODE_START_C = 105;
export const CODE_FNC1 = 102;
export const CODE_STOP = 106;
const MODULO = 103;

/** The symbol character `code` (0..106) as a string of 11 modules (13 for the stop), `1` = bar. */
export function patternModules(code: number): string {
  const runs = PATTERNS[code];
  if (runs === undefined) throw new RangeError(`Code 128 has no symbol character ${code}`);
  let out = "";
  let bar = true;
  for (const run of runs) {
    out += (bar ? "1" : "0").repeat(Number(run));
    bar = !bar;
  }
  return out;
}

/**
 * Modulo-103 check character: the start code plus every following data code
 * (FNC1 included) times its position, 1-based. `codes` is start + data, no check, no stop.
 */
export function code128Checksum(codes: readonly number[]): number {
  let sum = codes[0] ?? 0;
  for (let i = 1; i < codes.length; i++) sum += (codes[i] ?? 0) * i;
  return sum % MODULO;
}

export type Code128Kind = "CODE128B" | "GS1_128";

export interface Code128Symbol {
  kind: Code128Kind;
  /** What a scanner reports (for GS1-128: the element string `00<sscc>`, without brackets or a symbology identifier). */
  data: string;
  /** Start + data codes + check, without the stop. */
  codes: readonly number[];
  /** The check character (already the last of `codes`). */
  checksum: number;
  /** Bars and spaces, quiet zones NOT included, stop pattern included. */
  modules: string;
}

function assemble(kind: Code128Kind, data: string, body: readonly number[]): Code128Symbol {
  const checksum = code128Checksum(body);
  const codes = [...body, checksum];
  const modules = codes.map(patternModules).join("") + patternModules(CODE_STOP);
  return { kind, data, codes, checksum, modules };
}

/** Code 128 set B: printable ASCII 0x20..0x7E (DEL is left out on purpose: no label needs it). */
export function encodeCode128B(text: string): Code128Symbol {
  if (text === "") throw new RangeError("Code 128 cannot encode an empty string");
  const body: number[] = [CODE_START_B];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? -1;
    if (cp < 0x20 || cp > 0x7e) throw new RangeError(`Code 128 set B cannot encode U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    body.push(cp - 0x20);
  }
  return assemble("CODE128B", text, body);
}

/**
 * GS1-128 carrying one element: AI (00) + the 18-digit SSCC. Start C, FNC1, then the 20 digits
 * `00<sscc>` as ten pairs. Refuses anything but 18 digits with a valid GS1 check digit:
 * a label whose barcode a scanner (or the parser) would reject must not be printed.
 */
export function encodeGs1128Sscc(sscc: string): Code128Symbol {
  if (!/^\d{18}$/.test(sscc)) throw new RangeError("An SSCC is exactly 18 digits");
  if (!hasValidCheckDigit(sscc)) throw new RangeError("The SSCC check digit is wrong");
  const digits = `00${sscc}`;
  const body: number[] = [CODE_START_C, CODE_FNC1];
  for (let i = 0; i < digits.length; i += 2) body.push(Number(digits.slice(i, i + 2)));
  return assemble("GS1_128", digits, body);
}
