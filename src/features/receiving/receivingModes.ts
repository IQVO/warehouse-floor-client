import type { Mode } from "./scanToRequest";

export const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "carton", label: "Carton", hint: "Scan the carton label (SSCC)." },
  { id: "case", label: "Cases", hint: "Scan the case barcode once per case, or enter how many cases and scan once." },
  { id: "each", label: "Items", hint: "Scan each item, or enter how many and scan once." },
];
