import type { CompletionConfirmation, Task } from "../../api/fulfillmentExecution";

/** One scan the operator must make before the task can be completed. */
export interface ScanStep {
  id: "order" | "fromBin" | "toBin";
  label: string;
  /** Present when the plan fixes the value: the scan must equal it (case-insensitively). Absent: any scan is accepted. */
  expected?: string;
}

export type ConfirmPlan =
  | { supported: false; reason: string }
  | {
      supported: true;
      scans: ScanStep[];
      /** RELOCATE and REPLENISH are completed with a counted quantity. */
      quantity: { default?: number } | null;
      /** Builds the optional part of the complete request from what was scanned and counted. */
      toRequest(scans: Partial<Record<ScanStep["id"], string>>, quantity: number | undefined): CompletionConfirmation;
    };

/**
 * What the operator must confirm for each task type, mirroring the OpenAPI
 * rules for POST /tasks/{id}/complete:
 *  - PICK: nothing but the claim; here the operator scans the order label so a
 *    wrong tote is caught before the task is closed.
 *  - RELOCATE: counted quantity + the bins the plan left open (fromBin for an
 *    Assign, toBin for a Vacate); a side the plan fixed must equal the planned bin.
 *  - REPLENISH: counted quantity; both bins are planned and the scans must equal them.
 * Everything else is not finished in this release.
 */
export function buildConfirmPlan(task: Task): ConfirmPlan {
  switch (task.type) {
    case "PICK": {
      const expected = task.orderRef && task.orderRef !== "" ? task.orderRef : task.id;
      return {
        supported: true,
        scans: [{ id: "order", label: "Scan the order label", expected }],
        quantity: null,
        toRequest: () => ({}),
      };
    }
    case "RELOCATE": {
      const move = task.relocation;
      if (move === undefined) {
        return { supported: false, reason: "This move has no plan attached, so it cannot be confirmed here." };
      }
      return {
        supported: true,
        scans: [
          {
            id: "fromBin",
            label: move.fromBin ? "Scan the source bin" : "Scan the bin you took it from",
            ...(move.fromBin ? { expected: move.fromBin } : {}),
          },
          {
            id: "toBin",
            label: move.toBin ? "Scan the destination bin" : "Scan the bin you put it in",
            ...(move.toBin ? { expected: move.toBin } : {}),
          },
        ],
        quantity: {},
        toRequest: (scans, quantity) => ({
          ...(quantity === undefined ? {} : { quantity }),
          ...(scans.fromBin ? { fromBin: scans.fromBin } : {}),
          ...(scans.toBin ? { toBin: scans.toBin } : {}),
        }),
      };
    }
    case "REPLENISH": {
      const r = task.replenishment;
      if (r === undefined) {
        return { supported: false, reason: "This replenishment has no plan attached, so it cannot be confirmed here." };
      }
      return {
        supported: true,
        scans: [
          { id: "fromBin", label: "Scan the reserve bin", expected: r.fromBin },
          { id: "toBin", label: "Scan the pick face", expected: r.toBin },
        ],
        quantity: { default: r.quantity },
        toRequest: (scans, quantity) => ({
          ...(quantity === undefined ? {} : { quantity }),
          ...(scans.fromBin ? { fromBin: scans.fromBin } : {}),
          ...(scans.toBin ? { toBin: scans.toBin } : {}),
        }),
      };
    }
    default:
      return {
        supported: false,
        reason: `${task.type} tasks are finished on their own screens (pack, SLAM, put-wall), which this version does not have yet.`,
      };
  }
}

export function scanMatches(step: ScanStep, scanned: string): boolean {
  return step.expected === undefined || step.expected.toLowerCase() === scanned.toLowerCase();
}
