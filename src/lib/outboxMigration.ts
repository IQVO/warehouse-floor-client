/**
 * One-time migration of persisted outbox paths to the fleet REST guideline
 * routes (STANDARD 1.3-1.4 and 5.5). A command queued by an older build holds
 * the OLD path; replaying it would 404 forever, so the path is rewritten when
 * the outbox is read. Pure: only `path` changes. The Idempotency-Key, dedupeId,
 * body, method and queue position are untouched, so the retry still carries the
 * key of the original operator action.
 *
 * Anything that does not match a known legacy route is returned as is: a queued
 * write is never dropped here. An already-migrated path matches no rule, so the
 * migration is idempotent.
 */
const SEG = "[^/]+";

interface Rule {
  from: RegExp;
  to: string;
}

const FE = "/api/fulfillment-execution";
const IR = "/api/inbound-receiving";

const RULES: readonly Rule[] = [
  // fulfillment-execution
  { from: new RegExp(`^(${FE}/stations/${SEG})/claim-next$`), to: "$1/task-claims" },
  { from: new RegExp(`^(${FE}/stations/${SEG})/check-in$`), to: "$1/check-ins" },
  { from: new RegExp(`^(${FE}/stations/${SEG})/check-out$`), to: "$1/check-outs" },
  { from: new RegExp(`^(${FE}/tasks/${SEG})/renew-lease$`), to: "$1/lease-renewals" },
  { from: new RegExp(`^(${FE}/tasks/${SEG})/complete$`), to: "$1/completions" },
  { from: new RegExp(`^(${FE}/tasks/${SEG})/break-case$`), to: "$1/case-breaks" },
  { from: new RegExp(`^(${FE}/tasks/${SEG})/seal-package$`), to: "$1/package-seals" },
  { from: new RegExp(`^(${FE}/packages/${SEG})/slam$`), to: "$1/slam-runs" },
  { from: new RegExp(`^${FE}/tasks/expire-leases$`), to: `${FE}/task-lease-expirations` },
  { from: new RegExp(`^${FE}/tasks/sweep-cpt-misses$`), to: `${FE}/cpt-miss-sweeps` },
  // inbound-receiving
  { from: new RegExp(`^(${IR}/asns/${SEG})/cancel$`), to: "$1/cancellations" },
  { from: new RegExp(`^(${IR}/appointments/${SEG})/check-in$`), to: "$1/check-ins" },
  { from: new RegExp(`^(${IR}/appointments/${SEG})/cancel$`), to: "$1/cancellations" },
  { from: new RegExp(`^(${IR}/receipts/${SEG})/close$`), to: "$1/closures" },
];

/** The new route for a legacy path, or the same string when it is not a legacy route. */
export function migrateLegacyPath(path: string): string {
  for (const rule of RULES) {
    if (rule.from.test(path)) return path.replace(rule.from, rule.to);
  }
  return path;
}

/** Returns the same object when nothing changes. */
export function migrateLegacyEntry<T extends { path: string }>(entry: T): T {
  const path = migrateLegacyPath(entry.path);
  return path === entry.path ? entry : { ...entry, path };
}
