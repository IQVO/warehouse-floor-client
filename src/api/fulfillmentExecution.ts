import type { CommandRunner, Outcome } from "../lib/commands";

/**
 * fulfillment-execution, as far as the station flow needs it. Shapes and error
 * codes are taken from the service's apis/openapi.yaml (see docs/api-contract.md).
 *
 * Network rule: the page's own origin, path /api/fulfillment-execution/..., which
 * Kong routes. Never a service URL, never a port, never another host.
 */
export const FULFILLMENT_BASE = "/api/fulfillment-execution";

/** Every value of the OpenAPI `AnyTaskType`. */
export const TASK_TYPES = ["PICK", "PACK", "SLAM", "REBIN", "DISPATCH", "ARRIVAL", "RELOCATE", "REPLENISH"] as const;
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
