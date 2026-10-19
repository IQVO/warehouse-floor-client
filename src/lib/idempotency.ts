/**
 * Idempotency-Key generation.
 *
 * A key identifies ONE user action ("complete task 123"), not one HTTP
 * attempt. It is minted exactly once, when the action is first submitted, is
 * written to the outbox before the first byte is sent, and is reused verbatim
 * on every retry -- automatic replays, reconnects, a page reload, the operator
 * tapping the button again. A different action (or the same action with a
 * different body) gets a new key. See docs/offline-and-idempotency.md.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // crypto.randomUUID only exists in secure contexts; an RF gun on plain
  // http://<lan-host> is not one. getRandomValues is available everywhere.
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
