import type { Message } from "../../api/problemMessages";
import { describeYardProblem } from "../../api/yardMessages";
import type { CheckIn, Visit } from "../../api/yardManagement";
import type { Outcome } from "../../lib/commands";
import type { OutboxEntry } from "../../lib/outbox";
import { driverDirections, rejectionText } from "./yardFormat";

export const GATE_KINDS = ["yard-check-in", "yard-reject", "yard-check-out"];

/** The gate clerk's words for a gate command the service accepted, whether it was tapped or replayed. */
export function gateDoneMessage(kind: string, data: unknown): Message {
  if (kind === "yard-check-in") {
    const { visit } = data as CheckIn;
    return visit.state === "REJECTED"
      ? { tone: "warning", what: `Turned away: ${rejectionText(visit.rejectionReason)}.`, todo: "The truck does not enter. Tell the driver." }
      : { tone: "success", what: `${visit.tractorPlate} is checked in.`, todo: "Tell the driver where to take each trailer (below)." };
  }
  const plate = (data as Visit).tractorPlate;
  return kind === "yard-reject"
    ? { tone: "success", what: `${plate} was turned away and the refusal is recorded.`, todo: "Tell the driver." }
    : { tone: "success", what: `${plate} is checked out.`, todo: "Open the gate." };
}

const LABELS: Record<string, string> = {
  "yard-check-in": "check-in",
  "yard-reject": "rejection",
  "yard-check-out": "check-out",
  "yard-claim": "claim",
  "yard-complete-move": "move completion",
  "yard-door-start": "door work start",
  "yard-door-complete": "door work completion",
};

/**
 * A yard command answered on a replay while no yard screen that owns it is in view: the same words the screen
 * would use, led by what the answer is about (the entry is gone from the outbox, so this is where it is said).
 * Every refusal is said. Of the accepted ones, those the operator must act on: a gate command (a driver is
 * waiting) and a claim (a lease is running). A finished move or door-work step is not announced.
 */
export function describeYardSettled(entry: OutboxEntry, outcome: Outcome): Message | null {
  const label = LABELS[entry.kind] ?? "yard action";
  const plate = entry.meta.tractorPlate ?? "";
  const about = plate === "" ? `Saved ${label}: ` : `Saved ${label} (truck ${plate}): `;
  if (outcome.state === "problem") {
    const m = describeYardProblem(outcome.problem);
    return { ...m, what: `${about}${m.what}` };
  }
  if (outcome.state !== "done") return null;
  if (entry.kind === "yard-claim") return { tone: "info", what: "Saved claim: a move is yours.", todo: "Open the Hostler screen to see it. Its time is already running." };
  if (!GATE_KINDS.includes(entry.kind) || outcome.data === undefined) return null;
  const m = gateDoneMessage(entry.kind, outcome.data);
  if (entry.kind !== "yard-check-in") return { ...m, what: `Saved ${label}: ${m.what}` };
  const admitted = outcome.data as CheckIn;
  if (admitted.visit.state === "REJECTED") return { ...m, what: `${about}${m.what}` };
  const directions = driverDirections(admitted);
  return { ...m, what: `Saved ${label}: ${m.what}`, todo: directions.length === 0 ? "No trailer to place." : `Tell the driver: ${directions.map((d) => d.charAt(0).toLowerCase() + d.slice(1)).join(" ")}` };
}
