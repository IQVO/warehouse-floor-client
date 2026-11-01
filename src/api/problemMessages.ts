import { problemCode, type Problem } from "../lib/problem";
import type { RetryReason } from "../lib/commands";

/** A message for the operator: what happened, and what to do about it. */
export interface Message {
  tone: "info" | "success" | "warning" | "danger";
  what: string;
  todo: string;
}

const CLAIM_NEXT = "Pull the next task.";
const CALL_LEAD = "If it keeps happening, call your lead.";

/**
 * Plain-words text for each fulfillment-execution problem type (the last path
 * segment of `type`). The raw JSON, `detail` and `instance` are never shown:
 * `detail` is engineer wording ("usecases: station not found"), and the
 * operator cannot act on it.
 */
const BY_CODE: Record<string, Message> = {
  "station-not-found": {
    tone: "warning",
    what: "This station is not registered with the system.",
    todo: "Register the station again, then retry.",
  },
  "no-claimable-task": {
    tone: "info",
    what: "No work is waiting for this station right now.",
    todo: "Nothing is wrong. Wait a moment and ask again.",
  },
  "station-occupied": {
    tone: "warning",
    what: "Someone is already checked in at this station.",
    todo: "Ask them to check out, or use another station.",
  },
  "station-not-occupied": {
    tone: "warning",
    what: "Nobody is checked in at this station.",
    todo: "Check in first.",
  },
  "task-not-found": {
    tone: "warning",
    what: "The system does not know this task any more.",
    todo: CLAIM_NEXT,
  },
  "task-not-claimed": {
    tone: "warning",
    what: "You no longer hold this task: its time ran out, or it was already finished.",
    todo: CLAIM_NEXT,
  },
  "task-not-owner": {
    tone: "warning",
    what: "Another station now holds this task.",
    todo: CLAIM_NEXT,
  },
  "task-already-completed": {
    tone: "info",
    what: "This task was already completed.",
    todo: CLAIM_NEXT,
  },
  "invalid-request": {
    tone: "danger",
    what: "The system could not accept that: something is missing or not valid.",
    todo: `Check what you scanned or typed and try again. ${CALL_LEAD}`,
  },
  "idempotency-key-required": {
    tone: "danger",
    what: "The request could not be matched to your last action.",
    todo: `Reload the page and try again. ${CALL_LEAD}`,
  },
  "idempotency-key-reused": {
    tone: "danger",
    what: "That action conflicts with an earlier one that was sent with different details.",
    todo: `Reload the page and try again. ${CALL_LEAD}`,
  },
  "station-location-not-workcenter": {
    tone: "warning",
    what: "That location is not a work center.",
    todo: "Scan a work-center location label, or leave the location empty.",
  },
  "relocation-confirmation-required": {
    tone: "warning",
    what: "A move is finished with the counted quantity and the bin scans.",
    todo: "Scan the bins, enter the quantity you moved, and confirm again.",
  },
  "invalid-relocation-confirmation": {
    tone: "warning",
    what: "The bins you scanned do not fit the planned move.",
    todo: "Rescan the bins shown on the task.",
  },
  "not-relocation-task": {
    tone: "danger",
    what: "A quantity and bins were sent for a task that does not take them.",
    todo: `Complete the task again without them. ${CALL_LEAD}`,
  },
  "replenishment-confirmation-required": {
    tone: "warning",
    what: "A replenishment is finished with the quantity you counted.",
    todo: "Enter the quantity you moved and confirm again.",
  },
  "invalid-replenishment-confirmation": {
    tone: "warning",
    what: "The quantity or a scanned bin does not fit the replenishment.",
    todo: "Enter a quantity of 1 or more and rescan the bins shown on the task.",
  },
  // ---- POST /tasks/{id}/scans (PICK scan-confirm) ----
  "unknown-gtin": {
    tone: "warning",
    what: "The system does not know that barcode.",
    todo: "Check you scanned the item or case for this pick, then scan it again. If it keeps happening, call your lead.",
  },
  "invalid-scanned-gtin": {
    tone: "warning",
    what: "That barcode is not a valid product code (a digit is wrong, or it is a weight-priced item).",
    todo: "Scan it again. If it will not read, use Type instead. Nothing was counted.",
  },
  "scan-sku-mismatch": {
    tone: "warning",
    what: "That is not the item for this pick. It can be the item barcode printed on a case of something else.",
    todo: "Put it back and scan the item or case this pick asks for. Nothing was counted.",
  },
  "scan-level-mismatch": {
    tone: "warning",
    what: "You scanned a case where single items are picked, or a single item where cases are picked.",
    todo: "Scan the unit this pick asks for: the case barcode for a case pick, the item barcode for an item pick. Nothing was counted.",
  },
  "pick-over-quantity": {
    tone: "warning",
    what: "That scan would pick more than this task asks for. It was not counted.",
    todo: "Put the extra back. If the pick is complete, scan the order label and complete the task.",
  },
  "no-pick-plan": {
    tone: "warning",
    what: "This task has no pick quantity to scan against.",
    todo: "Scan the order label and complete the task, or ask your lead.",
  },
  // ---- POST /tasks/{id}/break-case (BREAK_CASE) ----
  "case-break-rejected": {
    tone: "danger",
    what: "The storage system refused to break this case.",
    todo: `Check the case is sealed and in its bin, then try again. ${CALL_LEAD}`,
  },
  "not-case-break-task": {
    tone: "danger",
    what: "This task is not a case-break task.",
    todo: `${CLAIM_NEXT} ${CALL_LEAD}`,
  },
  "case-break-completion-required": {
    tone: "warning",
    what: "A case-break task is finished with the Break case button, not with Complete.",
    todo: "Use Break case on this task's screen.",
  },
  "case-break-unavailable": {
    tone: "warning",
    what: "The storage system could not be reached to break the case. Nothing was changed.",
    todo: "Try again in a moment. The task is still yours.",
  },
  "internal-error": {
    tone: "danger",
    what: "The server hit an unexpected error.",
    todo: `Try again in a moment. ${CALL_LEAD}`,
  },
};

export function describeProblem(problem: Problem): Message {
  const known = BY_CODE[problemCode(problem)];
  if (known !== undefined) return known;

  // Not one of ours: a gateway or proxy answered (HTML or empty body), or a new
  // error code this build predates.
  if (problem.type === "about:blank") {
    if (problem.status === 404 || problem.status === 405) {
      return {
        tone: "danger",
        what: "The floor service cannot be reached at this address.",
        todo: "This is a setup problem, not something you did. Call your lead.",
      };
    }
    if (problem.status >= 500) {
      return {
        tone: "danger",
        what: "The floor service is not answering properly.",
        todo: `Try again in a moment. ${CALL_LEAD}`,
      };
    }
  }
  return {
    tone: problem.status >= 500 ? "danger" : "warning",
    // `title` is the service's fixed, category-level summary (never request data).
    what: problem.title.trim() !== "" ? `${problem.title.trim().replace(/[.\s]+$/, "")}.` : "The system refused that request.",
    todo: `Try again. ${CALL_LEAD}`,
  };
}

/** What to tell the operator when a command is saved but not yet delivered. */
export function describeQueued(label: string, reason: RetryReason): Message {
  return {
    tone: "warning",
    what:
      reason === "offline"
        ? `You are offline. Your ${label} is saved on this device.`
        : `The server could not be reached. Your ${label} is saved on this device.`,
    todo: "It will be sent automatically when the connection is back. You do not need to repeat it.",
  };
}

export function describeUnsent(what: string, reason: RetryReason): Message {
  return {
    tone: "warning",
    what: `${what} could not be sent (${reason === "offline" ? "you are offline" : "the server could not be reached"}).`,
    todo: "It will be tried again automatically.",
  };
}
