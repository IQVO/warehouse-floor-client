/**
 * Test support, not app code: an independent Code 128 reference (the 107 symbol characters as
 * 11/13 module bit strings, as published in the ISO/IEC 15417 table and used by JsBarcode) and a
 * decoder that turns printed modules back into what a scanner would report.
 */
export const REFERENCE_BITS: readonly string[] = [
  "11011001100", "11001101100", "11001100110", "10010011000",
  "10010001100", "10001001100", "10011001000", "10011000100",
  "10001100100", "11001001000", "11001000100", "11000100100",
  "10110011100", "10011011100", "10011001110", "10111001100",
  "10011101100", "10011100110", "11001110010", "11001011100",
  "11001001110", "11011100100", "11001110100", "11101101110",
  "11101001100", "11100101100", "11100100110", "11101100100",
  "11100110100", "11100110010", "11011011000", "11011000110",
  "11000110110", "10100011000", "10001011000", "10001000110",
  "10110001000", "10001101000", "10001100010", "11010001000",
  "11000101000", "11000100010", "10110111000", "10110001110",
  "10001101110", "10111011000", "10111000110", "10001110110",
  "11101110110", "11010001110", "11000101110", "11011101000",
  "11011100010", "11011101110", "11101011000", "11101000110",
  "11100010110", "11101101000", "11101100010", "11100011010",
  "11101111010", "11001000010", "11110001010", "10100110000",
  "10100001100", "10010110000", "10010000110", "10000101100",
  "10000100110", "10110010000", "10110000100", "10011010000",
  "10011000010", "10000110100", "10000110010", "11000010010",
  "11001010000", "11110111010", "11000010100", "10001111010",
  "10100111100", "10010111100", "10010011110", "10111100100",
  "10011110100", "10011110010", "11110100100", "11110010100",
  "11110010010", "11011011110", "11011110110", "11110110110",
  "10101111000", "10100011110", "10001011110", "10111101000",
  "10111100010", "11110101000", "11110100010", "10111011110",
  "10111101110", "11101011110", "11110101110", "11010000100",
  "11010010000", "11010011100", "1100011101011",
];

export interface Decoded {
  /** True when FNC1 followed the start code (GS1-128). */
  gs1: boolean;
  /** Data characters; an FNC1 elsewhere in the data is GS (0x1D). */
  text: string;
  codes: number[];
}

/** Decodes bars/spaces (quiet zones already stripped, stop included). Throws on any pattern or check-character error. */
export function decodeModules(modules: string): Decoded {
  const stop = REFERENCE_BITS[106] as string;
  if (!modules.endsWith(stop)) throw new Error("no stop pattern");
  const body = modules.slice(0, modules.length - stop.length);
  if (body.length % 11 !== 0) throw new Error("not a whole number of symbol characters");
  const codes: number[] = [];
  for (let i = 0; i < body.length; i += 11) {
    const code = REFERENCE_BITS.indexOf(body.slice(i, i + 11));
    if (code < 0 || code > 105) throw new Error(`unknown symbol character at module ${i}`);
    codes.push(code);
  }
  const check = codes.pop() as number;
  let sum = codes[0] as number;
  for (let i = 1; i < codes.length; i++) sum += (codes[i] as number) * i;
  if (sum % 103 !== check) throw new Error(`check character ${check} != ${sum % 103}`);
  const start = codes[0];
  let set = start === 104 ? "B" : start === 105 ? "C" : "?";
  if (set === "?") throw new Error("only start B / start C are used here");
  let text = "";
  let gs1 = false;
  for (let i = 1; i < codes.length; i++) {
    const c = codes[i] as number;
    if (c === 102) {
      if (i === 1) gs1 = true;
      else text += "\u001d";
    } else if (c === 99) set = "C";
    else if (c === 100) set = "B";
    else if (set === "C") text += String(c).padStart(2, "0");
    else text += String.fromCharCode(c + 32);
  }
  return { gs1, text, codes: codes.slice() };
}
