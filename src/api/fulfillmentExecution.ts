import type { CommandRunner, Outcome } from "../lib/commands";

/**
 * fulfillment-execution, as far as the station flow needs it. Shapes and error
 * codes are taken from the service's apis/openapi.yaml (see docs/api-contract.md).
 *
 * Network rule: the page's own origin, path /api/fulfillment-execution/..., which
 * Kong routes. Never a service URL, never a port, never another host.
 */
export const FULFILLMENT_BASE = "/api/fulfillment-execution";

/**
 * Every value of the OpenAPI `AnyTaskType`, plus BREAK_CASE (ADR 0054): the
 * service creates and completes it (POST /tasks/{id}/break-case) but
 * `AnyTaskType` does not list it yet, so claim-next is not offered for it
 * (see CLAIMABLE_TASK_TYPES and docs/api-contract.md).
 */
export const TASK_TYPES = ["PICK", "PACK", "SLAM", "REBIN", "DISPATCH", "ARRIVAL", "RELOCATE", "REPLENISH", "BREAK_CASE"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * The task types this client can finish today. PACK and SLAM need the
 * seal-package / slam screens, REBIN the put-wall, DISPATCH/ARRIVAL their own
 * flows: all later work. They are not offered at claim time.
 */
export const CLAIMABLE_TASK_TYPES: readonly TaskType[] = ["PICK", "RELOCATE", "REPLENISH"];

export interface Station {
  id: string;
  capabilities: string[];
  occupied: boolean;
  locationCode?: string;
}

export interface TaskRelocation {
  planId: string;
  moveSeq: number;
  kind: "Relocate" | "Assign" | "Vacate";
  sku: string;
  /** Omitted for an Assign (the operator scans it). */
  fromBin?: string;
  /** Omitted for a Vacate (the operator scans it). */
  toBin?: string;
  ref: string;
}

export interface TaskReplenishment {
  requestId: string;
  sku: string;
  fromBin: string;
  toBin: string;
  quantity: number;
  priority: "NORMAL" | "URGENT";
}

export interface Task {
  id: string;
  type: string;
  status: "PENDING" | "CLAIMED" | "COMPLETED";
  cpt?: string;
  orderRef?: string;
  requiredCapabilities?: string[];
  fragile?: boolean;
  giftWrap?: boolean;
  leaseStationId?: string | null;
  leaseExpiry?: string | null;
  relocation?: TaskRelocation;
  replenishment?: TaskReplenishment;
}

/** PickScanResult: every quantity in eaches. `level` is the pack level of the GTIN that was scanned. */
export interface PickScanResult {
  scannedGtin: string;
  sku: string;
  level: "EACH" | "INNER" | "CASE" | "PALLET";
  addedEaches: number;
  pickedEaches: number;
  plannedEaches: number;
}

/** The optional part of CompleteTaskRequest (RELOCATE / REPLENISH only). */
export interface CompletionConfirmation {
  quantity?: number;
  fromBin?: string;
  toBin?: string;
}

const seg = encodeURIComponent;

/** Command builders; each returns the typed outcome of one user action. */
export function fulfillmentApi(runner: CommandRunner) {
  return {
    registerStation(input: { stationId: string; capabilities: string[]; locationCode?: string }): Promise<Outcome<Station>> {
      return runner.submit<Station>({
        kind: "register",
        path: `${FULFILLMENT_BASE}/stations`,
        body: {
          stationId: input.stationId,
          capabilities: input.capabilities,
          ...(input.locationCode ? { locationCode: input.locationCode } : {}),
        },
        dedupeId: `register:${input.stationId}`,
        meta: { stationId: input.stationId },
      });
    },

    checkIn(stationId: string, occupantId: string): Promise<Outcome<Station>> {
      return runner.submit<Station>({
        kind: "check-in",
        path: `${FULFILLMENT_BASE}/stations/${seg(stationId)}/check-in`,
        body: { occupantId },
        dedupeId: `check-in:${stationId}`,
        meta: { stationId, occupantId },
      });
    },

    checkOut(stationId: string): Promise<Outcome<Station>> {
      return runner.submit<Station>({
        kind: "check-out",
        path: `${FULFILLMENT_BASE}/stations/${seg(stationId)}/check-out`,
        dedupeId: `check-out:${stationId}`,
        meta: { stationId },
      });
    },

    /**
     * 200 + Task when work was leased; 409 `no-claimable-task` when the pool has
     * nothing this station can do (not an error: ask again later); 404
     * `station-not-found` when the station is not registered.
     */
    claimNext(stationId: string, taskType: TaskType): Promise<Outcome<Task>> {
      return runner.submit<Task>({
        kind: "claim-next",
        path: `${FULFILLMENT_BASE}/stations/${seg(stationId)}/claim-next`,
        body: { taskType },
        // One pending claim per station: asking again (even for another type)
        // must not leave two claims queued.
        dedupeId: `claim-next:${stationId}`,
        meta: { stationId, taskType },
      });
    },

    /** 204 on success. Fire-and-forget: never queued (see CommandSpec.persist). */
    renewLease(taskId: string, stationId: string): Promise<Outcome<undefined>> {
      return runner.submit<undefined>({
        kind: "renew-lease",
        path: `${FULFILLMENT_BASE}/tasks/${seg(taskId)}/renew-lease`,
        body: { stationId },
        persist: false,
        meta: { taskId, stationId },
      });
    },

    /**
     * One scan of an each or case GTIN against a PICK task. `gtin` is the
     * 14-digit form; `count` is packs scanned (eaches for an EACH GTIN, cases
     * for a CASE GTIN: the server multiplies, the client never does).
     *
     * Each physical scan is its own action (`scanId` makes the dedupe id
     * unique), so two scans of the same case count twice; a scan that was
     * saved offline or whose answer was lost is replayed with ITS key.
     */
    confirmPickScan(taskId: string, stationId: string, gtin: string, scanId: string, count = 1): Promise<Outcome<PickScanResult>> {
      return runner.submit<PickScanResult>({
        kind: "pick-scan",
        path: `${FULFILLMENT_BASE}/tasks/${seg(taskId)}/scans`,
        body: { stationId, gtin, count },
        dedupeId: `pick-scan:${taskId}:${scanId}`,
        meta: { taskId, stationId, gtin },
      });
    },

    /** 204: the sealed case was broken and the task completed. One logical action per task, so a re-tap or a reload reuses the key. */
    breakCase(taskId: string, stationId: string): Promise<Outcome<undefined>> {
      return runner.submit<undefined>({
        kind: "break-case",
        path: `${FULFILLMENT_BASE}/tasks/${seg(taskId)}/break-case`,
        body: { stationId },
        dedupeId: `break-case:${taskId}`,
        meta: { taskId, stationId },
      });
    },

    /** 204 on success. Queued offline and replayed with the same key. */
    completeTask(taskId: string, stationId: string, confirmation: CompletionConfirmation = {}): Promise<Outcome<undefined>> {
      return runner.submit<undefined>({
        kind: "complete",
        path: `${FULFILLMENT_BASE}/tasks/${seg(taskId)}/complete`,
        body: { stationId, ...confirmation },
        dedupeId: `complete:${taskId}`,
        meta: { taskId, stationId },
      });
    },
  };
}

export type FulfillmentApi = ReturnType<typeof fulfillmentApi>;
