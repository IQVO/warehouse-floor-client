import type { ScanResult } from "../../api/inboundReceiving";
import type { Message } from "../../api/problemMessages";
import { describeFinding, describeReceivingProblem } from "../../api/receivingMessages";
import type { Outcome } from "../../lib/commands";
import type { OutboxEntry } from "../../lib/outbox";

/**
 * A receiving command answered on a replay while its receipt is not the one on screen: receiving's own words,
 * led by which receipt it was. Every refusal is said, and every scan the service did not book or flagged with
 * a finding. A scan that was simply received, and a closed receipt, are not announced.
 */
export function describeReceivingSettled(entry: OutboxEntry, outcome: Outcome): Message | null {
  const label = entry.kind === "close-receipt" ? "close request" : "scan";
  const receiptId = entry.meta.receiptId ?? "";
  const about = receiptId === "" ? `Saved ${label}: ` : `Saved ${label} (receipt ${receiptId}): `;
  if (outcome.state === "problem") {
    const m = describeReceivingProblem(outcome.problem);
    return { ...m, what: `${about}${m.what}` };
  }
  if (outcome.state !== "done" || entry.kind !== "receive-scan") return null;
  const result = outcome.data as ScanResult | undefined;
  if (result === undefined) return null;
  const [first, ...more] = result.discrepancies;
  if (first === undefined) {
    return result.accepted ? null : { tone: "warning", what: `${about}Not received. Nothing was booked for that scan.`, todo: "Open the receipt and scan it again." };
  }
  const copy = describeFinding(first);
  return {
    tone: copy.tone,
    what: `${about}${copy.title}. ${result.accepted ? "It was received." : "Nothing was booked for that scan."}`,
    todo: more.length === 0 ? copy.todo : `${copy.todo} There ${more.length === 1 ? "is 1 more finding" : `are ${more.length} more findings`} for that scan: tell your lead.`,
  };
}
