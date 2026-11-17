import { describeProblem, describeQueued, describeUnsent, type Message } from "./problemMessages";
import { problemCode, type Problem } from "../lib/problem";
import type { Outcome } from "../lib/commands";

const CALL_LEAD = "If it keeps happening, call your lead.";

/**
 * Problem slugs of yard-management that the gate clerk, hostler and dock
 * operator can meet (slug = last path segment of the problem `type`). The
 * service's `detail` is engineer wording and is never shown.
 */
const BY_CODE: Record<string, Message> = {
  "appointment-required": {
    tone: "warning",
    what: "This site only lets in trucks with an appointment.",
    todo: "Enter the appointment id from the driver's paperwork. With none, turn the truck away (Reject at the gate).",
  },
  "unknown-appointment": {
    tone: "warning",
    what: "The system does not know that appointment, or it does not fit this visit (an appointment covers exactly one trailer).",
    todo: "Check the appointment id and that exactly one trailer is listed. With no valid appointment, turn the truck away.",
  },
  "visit-already-open": {
    tone: "warning",
    what: "This tractor plate is already checked in.",
    todo: "Check the plate. If the truck is leaving, check the visit out instead.",
  },
  "trailer-already-on-site": {
    tone: "warning",
    what: "A trailer with that unit number is already on site.",
    todo: "Check the unit number on the trailer. If it is the same trailer, ask your lead.",
  },
  "door-closed": {
    tone: "warning",
    what: "The door this truck was booked to is closed.",
    todo: "Tell your lead. The truck waits at the gate or is sent to the holding area.",
  },
  "door-flow-mismatch": {
    tone: "warning",
    what: "This trailer does not fit the door: its load goes the other way (inbound or outbound).",
    todo: "Check the load state and purpose you entered. If they are right, ask your lead.",
  },
  "no-free-spot": {
    tone: "warning",
    what: "There is no free parking spot in the yard right now.",
    todo: "Hold the truck at the gate and try again in a moment.",
  },
  "invalid-carrier": {
    tone: "warning",
    what: "The carrier details are not valid.",
    todo: "Check the carrier name and the carrier code (2 to 4 capital letters), then try again.",
  },
  validation: {
    tone: "warning",
    what: "The system could not accept that: something is missing or not valid.",
    todo: "Check the plate, trailer numbers, kind and load state, then try again.",
  },
  "illegal-transition": {
    tone: "warning",
    what: "That cannot be done in the state it is in now. Someone else may have just done it.",
    todo: "Reload the list to see the current state.",
  },
  "trailer-not-released": {
    tone: "warning",
    what: "A trailer is not ready to leave: it still has a move open, or it is at a door with work not finished.",
    todo: "Finish or cancel the move, or finish the door work, then check out again. Leave that trailer off to take the rest.",
  },
  "seal-required": {
    tone: "warning",
    what: "A loaded trailer needs a seal before it leaves.",
    todo: "Record the seal on the trailer, then check out again.",
  },
  "trailer-has-open-move": {
    tone: "warning",
    what: "That trailer already has a move open.",
    todo: "Finish that move first.",
  },
  "trailer-on-hold": {
    tone: "warning",
    what: "This trailer is on hold, so door work cannot start.",
    todo: "Tell your lead. The hold has to be released first.",
  },
  "hostler-busy": {
    tone: "warning",
    what: "You already hold a move.",
    todo: "Complete it first. If you cannot find it, reload this screen.",
  },
  "no-claimable-move": {
    tone: "info",
    what: "No move is waiting for you right now.",
    todo: "Nothing is wrong. Wait a moment and ask again.",
  },
  "not-lease-holder": {
    tone: "warning",
    what: "You no longer hold this move: your time ran out, or someone else has it.",
    todo: "Claim the next move.",
  },
  "unexplained-destination": {
    tone: "warning",
    what: "The trailer is not at the planned place, so a reason is needed.",
    todo: "Type why you left it elsewhere, then complete again.",
  },
  "location-occupied": {
    tone: "warning",
    what: "That place already holds a trailer.",
    todo: "Pick another free place, scan it, and add a reason. The move is still yours.",
  },
  "destination-reserved": {
    tone: "warning",
    what: "That place is reserved for another move.",
    todo: "Pick another free place, scan it, and add a reason.",
  },
  "unknown-location": {
    tone: "warning",
    what: "The system does not know that location.",
    todo: "Scan the label on the spot or door again, and check you chose Spot or Door correctly.",
  },
  // ---- yard-management ADR 0016: a suspended carrier under the site's REJECT rule (POST /visits) ----
  // The service records the REJECTED visit and THEN answers this 409. Nothing here may suggest another
  // check-in or a manual reject: each one would put a second turn-away on record.
  "carrier-suspended": {
    tone: "warning",
    what: "This carrier is suspended, so the truck is turned away. The turn-away is already recorded.",
    todo: "The truck does not enter. Tell the driver. Nothing more to enter: do not check it in again or use Reject.",
  },
  // ---- ADR 0012: identifiers at the gate (POST /visits) ----
  "seal-class-too-low": {
    tone: "warning",
    what: "This site only takes seals of a set strength, and this trailer's seal is weaker or its strength is not on record.",
    todo: "Tell your lead. The truck waits at the gate; if the seal cannot be accepted, turn it away (Reject at the gate).",
  },
  "invalid-unit-number": {
    tone: "warning",
    what: "That is not a valid container number: 4 capital letters and 7 digits, with no spaces or dashes.",
    todo: "Check it against the number on the container and enter it again. If the unit is not a container, change its kind.",
  },
  // ---- ADR 0014: what a trailer carries decides where it may park (POST /visits, move completion) ----
  "placement-rule-violated": {
    tone: "warning",
    what: "This trailer carries dangerous goods or a load that needs cooling, and it may only stand on a spot set aside for that.",
    todo: "Take it to a spot set aside for that load and scan that one. If there is none, ask your lead.",
  },
  // ---- ADR 0013: dock safety (door work start; check-out and claim of a trailer at a door) ----
  "trailer-not-secured": {
    tone: "warning",
    what: "This site starts door work only on a trailer that is recorded as secured (restraint or wheel chocks).",
    todo: "Secure the trailer and tell your lead, so it is recorded. Then start door work again.",
  },
  "trailer-still-secured": {
    tone: "warning",
    what: "A trailer is still secured at its dock door (restraint or wheel chocks), so it cannot leave.",
    todo: "It has to be released at the dock first, and the release recorded. Tell your lead, then try again.",
  },
  // ---- ADR 0015: inspections a site requires before docking, loading or leaving ----
  "inspection-required": {
    tone: "warning",
    what: "This site wants a passed inspection of the trailer before this step, and none is on record.",
    todo: "Tell your lead. Try again once the trailer has been inspected and passed.",
  },
  "inspection-failed": {
    tone: "warning",
    what: "The trailer's latest inspection failed, so this step is blocked.",
    todo: "Tell your lead. The trailer has to be inspected again and pass first.",
  },
  "trailer-not-found": { tone: "warning", what: "The system does not know that trailer.", todo: "Reload the list and try again." },
  "visit-not-found": { tone: "warning", what: "The system does not know that visit.", todo: "Check the plate and look it up again." },
  "move-not-found": { tone: "warning", what: "The system does not know that move.", todo: "Reload and try again." },
  "malformed-request-body": {
    tone: "danger",
    what: "The system could not read that request.",
    todo: `Check what you entered and try again. ${CALL_LEAD}`,
  },
  "precondition-failed": {
    tone: "warning",
    what: "It changed while you were working on it.",
    todo: "Reload and try again.",
  },
  "dependency-unavailable": {
    tone: "danger",
    what: "The yard service is not ready.",
    todo: `Try again in a moment. ${CALL_LEAD}`,
  },
};

/** Yard-specific copy first; anything else falls back to the shared table (idempotency, 5xx, gateway). */
export function describeYardProblem(problem: Problem): Message {
  return BY_CODE[problemCode(problem)] ?? describeProblem(problem);
}

/** Problem slugs this build has copy for (the test asserts the OpenAPI ones are all here). */
export const YARD_PROBLEM_CODES = Object.keys(BY_CODE);

/** The message for any outcome that is not a success; null for `done`. */
export function describeYardFailure(outcome: Outcome, label: string): Message | null {
  switch (outcome.state) {
    case "done":
      return null;
    case "problem":
      return describeYardProblem(outcome.problem);
    case "queued":
      return describeQueued(label, outcome.reason);
    case "unsent":
      return describeUnsent(label, outcome.reason);
  }
}

/** Reads (GET) that failed: the problem, or the unreachable note. */
export function describeYardReadFailure(result: { state: "problem"; problem: Problem } | { state: "unreachable" }, what: string): Message {
  return result.state === "problem"
    ? describeYardProblem(result.problem)
    : { tone: "warning", what: `The server could not be reached, so ${what} cannot be shown.`, todo: "Check the connection and try again." };
}
