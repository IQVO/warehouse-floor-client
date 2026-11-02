import { describe, expect, it } from "vitest";
import { CommandRunner } from "./commands";
import { Connectivity } from "./connectivity";
import { Outbox, type OutboxEntry } from "./outbox";
import { migrateLegacyPath } from "./outboxMigration";
import { MemoryStore } from "./storage";
import { createFetchStub, noContent } from "../test/fetchStub";

const FE = "/api/fulfillment-execution";
const IR = "/api/inbound-receiving";

const LEGACY_TO_NEW: [string, string][] = [
  [`${FE}/stations/S%201/claim-next`, `${FE}/stations/S%201/task-claims`],
  [`${FE}/stations/S1/check-in`, `${FE}/stations/S1/check-ins`],
  [`${FE}/stations/S1/check-out`, `${FE}/stations/S1/check-outs`],
  [`${FE}/tasks/t-1/renew-lease`, `${FE}/tasks/t-1/lease-renewals`],
  [`${FE}/tasks/t-1/complete`, `${FE}/tasks/t-1/completions`],
  [`${FE}/tasks/t-1/break-case`, `${FE}/tasks/t-1/case-breaks`],
  [`${FE}/tasks/t-1/seal-package`, `${FE}/tasks/t-1/package-seals`],
  [`${FE}/packages/p-1/slam`, `${FE}/packages/p-1/slam-runs`],
  [`${FE}/tasks/expire-leases`, `${FE}/task-lease-expirations`],
  [`${FE}/tasks/sweep-cpt-misses`, `${FE}/cpt-miss-sweeps`],
  [`${IR}/asns/A1/cancel`, `${IR}/asns/A1/cancellations`],
  [`${IR}/appointments/ap-1/check-in`, `${IR}/appointments/ap-1/check-ins`],
  [`${IR}/appointments/ap-1/cancel`, `${IR}/appointments/ap-1/cancellations`],
  [`${IR}/receipts/r-1/close`, `${IR}/receipts/r-1/closures`],
];

function entry(key: string, path: string, extra: Partial<OutboxEntry> = {}): OutboxEntry {
  return { key, kind: "x", method: "POST", path, body: { n: key }, dedupeId: `d:${key}`, meta: { m: key }, createdAt: 1, attempts: 2, ...extra };
}

describe("migrateLegacyPath", () => {
  it.each(LEGACY_TO_NEW)("%s -> %s", (legacy, next) => {
    expect(migrateLegacyPath(legacy)).toBe(next);
  });

  it.each(LEGACY_TO_NEW)("is idempotent: %s", (legacy) => {
    const once = migrateLegacyPath(legacy);
    expect(migrateLegacyPath(once)).toBe(once);
  });

  it("leaves current and unknown routes untouched", () => {
    for (const path of [
      `${FE}/stations`,
      `${FE}/tasks/t-1/scans`,
      `${IR}/receipts/r-1/scans`,
      `${FE}/tasks/t-1/completions`,
      `${FE}/tasks/t-1/mystery-verb`,
      "/api/other-context/tasks/t-1/complete",
    ]) {
      expect(migrateLegacyPath(path)).toBe(path);
    }
  });
});

describe("Outbox.read migration", () => {
  it("migrates legacy entries, keeping key, dedupeId, body, method and queue position", () => {
    const store = new MemoryStore();
    const legacy = [
      entry("k1", `${FE}/tasks/t-1/complete`),
      entry("k2", `${FE}/stations`),
      entry("k3", `${IR}/receipts/r-1/close`),
    ];
    store.setItem("wfc.outbox.v1", JSON.stringify(legacy));

    const list = new Outbox(store).list();
    expect(list.map((e) => e.key)).toEqual(["k1", "k2", "k3"]);
    expect(list.map((e) => e.path)).toEqual([`${FE}/tasks/t-1/completions`, `${FE}/stations`, `${IR}/receipts/r-1/closures`]);
    expect(list.map(({ path: _p, ...rest }) => rest)).toEqual(legacy.map(({ path: _p, ...rest }) => rest));
  });

  it("persists the migration and is a no-op the second time", () => {
    const store = new MemoryStore();
    store.setItem("wfc.outbox.v1", JSON.stringify([entry("k1", `${FE}/tasks/t-1/break-case`)]));
    new Outbox(store);
    const stored = store.getItem("wfc.outbox.v1");
    expect(JSON.parse(stored ?? "[]")[0].path).toBe(`${FE}/tasks/t-1/case-breaks`);
    new Outbox(store);
    expect(store.getItem("wfc.outbox.v1")).toBe(stored);
  });

  it("leaves already-new and unknown entries unchanged", () => {
    const store = new MemoryStore();
    const raw = JSON.stringify([entry("k1", `${FE}/tasks/t-1/completions`), entry("k2", `${FE}/tasks/t-1/odd`)]);
    store.setItem("wfc.outbox.v1", raw);
    expect(new Outbox(store).list().map((e) => e.path)).toEqual([`${FE}/tasks/t-1/completions`, `${FE}/tasks/t-1/odd`]);
    expect(store.getItem("wfc.outbox.v1")).toBe(raw);
  });

  it("a legacy queued command replays on the NEW route with its ORIGINAL Idempotency-Key", async () => {
    const store = new MemoryStore();
    store.setItem("wfc.outbox.v1", JSON.stringify([entry("original-key", `${FE}/tasks/t-1/complete`, { body: { stationId: "s-1" } })]));
    const fetchStub = createFetchStub().on(`POST ${FE}/tasks/t-1/completions`, noContent());
    const outbox = new Outbox(store);
    const runner = new CommandRunner({
      outbox,
      connectivity: new Connectivity(true),
      fetchFn: () => fetchStub as unknown as typeof fetch,
      newKey: () => "fresh-key-must-not-be-used",
    });
    await runner.flush();
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]?.headers["idempotency-key"]).toBe("original-key");
    expect(outbox.list()).toHaveLength(0);
  });
});
