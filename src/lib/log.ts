/**
 * Log-injection guard.
 *
 * Anything that came from outside this module -- a scanned barcode, a typed
 * station id, a path built from them, a Problem+JSON field -- can carry CR/LF
 * and forge a log line (or, in a browser console that is shipped to a
 * collector, a whole fake record). Every value is flattened to one line and
 * stripped of control characters before it reaches the console.
 *
 * Rule: never pass request-derived data to console.* directly; go through `log`.
 */
const MAX_LEN = 200;

export function sanitizeForLog(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = `${value.name}: ${value.message}`;
  } else {
    try {
      text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    } catch {
      text = String(value);
    }
  }
  // CR, LF, the Unicode line/paragraph separators, NEL and every other C0/C1
  // control character become a single space (not removed: "a\r\nb" must stay
  // readable as two tokens, never fuse into "ab").
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  return flat.length > MAX_LEN ? `${flat.slice(0, MAX_LEN)}...` : flat;
}

type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, values: unknown[]): void {
  // `message` is always a literal written in this codebase; only `values`
  // can be request-derived, so only they are sanitized -- and the literal is
  // sanitized too, in case a caller interpolates into it by mistake.
  const line = [sanitizeForLog(message), ...values.map(sanitizeForLog)].join(" ");
  console[level](`[floor] ${line}`);
}

export const log = {
  info: (message: string, ...values: unknown[]) => emit("info", message, values),
  warn: (message: string, ...values: unknown[]) => emit("warn", message, values),
  error: (message: string, ...values: unknown[]) => emit("error", message, values),
};
