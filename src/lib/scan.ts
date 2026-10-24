/**
 * Scan handling, independent of React so it can be tested (and reasoned about) alone.
 *
 * A keyboard-wedge scanner types the barcode as keystrokes and finishes with
 * Enter. Some are configured to add a Tab or a prefix/suffix, and a few emit
 * a stray control character. What reaches the app must be a clean token.
 */
export const MAX_SCAN_LENGTH = 128;

/**
 * Cleans a raw scan: drops every control character (CR, LF, TAB, ESC, NUL...),
 * EXCEPT GS (0x1D): the FNC1 separator of a GS1-128 element string, without which a
 * variable-length lot (AI 10) cannot be told from the AI that follows it,
 * trims, and refuses oversized input (a stuck key or a pasted blob is not a
 * barcode). Returns "" for anything that is not a usable scan.
 */
export function normalizeScan(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001c\u001e-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim();
  return cleaned.length > MAX_SCAN_LENGTH ? "" : cleaned;
}

/**
 * Scanners double-fire on a bounce or a held trigger. The same value inside
 * `windowMs` is one scan, not two; a different value (or the same one later)
 * always passes.
 */
export function createScanDeduper(windowMs = 400, now: () => number = Date.now) {
  let lastValue = "";
  let lastAt = Number.NEGATIVE_INFINITY;
  return {
    accept(value: string): boolean {
      const t = now();
      const duplicate = value === lastValue && t - lastAt < windowMs;
      lastValue = value;
      lastAt = t;
      return !duplicate;
    },
    reset(): void {
      lastValue = "";
      lastAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/** True when a keydown is ordinary typed text (what a wedge scanner produces), not a shortcut or navigation key. */
export function isPrintableKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** True when the element already takes typing, so the global scan capture must not steal the key. */
export function isEditable(el: Element | null): boolean {
  if (el === null) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el instanceof HTMLElement && el.isContentEditable === true;
}
