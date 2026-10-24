import { describeProblem, type Message } from "./problemMessages";
import { problemCode, type Problem } from "../lib/problem";
import type { CartonDiscrepancy } from "./inboundReceiving";

const CALL_LEAD = "If it keeps happening, call your lead.";

/** Problem slugs of inbound-receiving that the dock operator can meet on the scan/close/read calls. */
const BY_CODE: Record<string, Message> = {
  "receipt-not-found": {
    tone: "warning",
    what: "The system does not know that receipt.",
    todo: "Check the receipt number on the paperwork, or pick one from the open receipts.",
  },
  "invalid-receipt-id": {
    tone: "warning",
    what: "That is not a receipt number.",
    todo: "Check the receipt number and enter it again.",
  },
  "receipt-closed": {
    tone: "info",
    what: "This receipt is already closed. Nothing more can be received on it.",
    todo: "If goods are still on the dock, ask your lead.",
  },
  "scan-kind-mismatch": {
    tone: "warning",
    what: "That barcode is not the kind this step expects. Nothing was received.",
    todo: "Choose Carton, Cases or Items to match what you are scanning, then scan again.",
  },
  "invalid-sscc": {
    tone: "warning",
    what: "That carton label (SSCC) was misread or is not valid.",
    todo: "Scan the carton label again. If it will not scan, receive the carton as an unlabelled case.",
  },
  "invalid-gtin": {
    tone: "warning",
    what: "That item or case barcode was misread or is not valid.",
    todo: "Scan the barcode again.",
  },
  "unsupported-gtin": {
    tone: "warning",
    what: "That barcode cannot be received here (for example a weight-priced item).",
    todo: "Set the goods aside and ask your lead.",
  },
  "unsupported-pack-level": {
    tone: "warning",
    what: "That barcode is for a pack size that is not received by scan (for example a pallet).",
    todo: "Scan the carton label, or the barcode on the case or item.",
  },
  "invalid-scan-kind": { tone: "danger", what: "The scan was not understood by the system.", todo: `Scan again. ${CALL_LEAD}` },
  "invalid-scan": { tone: "danger", what: "The scan was not understood by the system.", todo: `Scan again. ${CALL_LEAD}` },
  "invalid-cases": {
    tone: "warning",
    what: "The number of cases is not valid.",
    todo: "Enter a whole number from 1 to 1000 and scan again.",
  },
  "invalid-quantity": {
    tone: "warning",
    what: "The quantity is not valid.",
    todo: "Enter a whole number of 1 or more and scan again.",
  },
  "invalid-counted-contents": {
    tone: "warning",
    what: "The audit count is not valid.",
    todo: "Check each SKU and quantity (whole numbers, 0 or more), then scan the carton again.",
  },
  "counted-contents-not-mixed": {
    tone: "warning",
    what: "An audit count only applies to a mixed carton, and this carton is not mixed. Nothing was received.",
    todo: "Clear the audit count and scan the carton again.",
  },
  "counted-sku-unknown": {
    tone: "warning",
    what: "A SKU in your audit count is not known to the system. Nothing was received.",
    todo: "Check the SKU spelling in the count, then scan the carton again.",
  },
  "carton-not-found": {
    tone: "warning",
    what: "The system has no accepted carton with that number on this receipt.",
    todo: "Scan the carton first, then print its label.",
  },
  "version-mismatch": {
    tone: "warning",
    what: "The receipt changed while you were working on it.",
    todo: "Reload the receipt and try again.",
  },
  "concurrent-modification": {
    tone: "warning",
    what: "Someone else changed this receipt at the same moment.",
    todo: "Scan again.",
  },
  "dependency-unavailable": {
    tone: "danger",
    what: "The receiving service is not ready.",
    todo: `Try again in a moment. ${CALL_LEAD}`,
  },
  "malformed-request": {
    tone: "danger",
    what: "The system could not read that request.",
    todo: `Scan again. ${CALL_LEAD}`,
  },
};

/** Receiving-specific copy first; anything else falls back to the shared table (idempotency, 5xx, gateway). */
export function describeReceivingProblem(problem: Problem): Message {
  return BY_CODE[problemCode(problem)] ?? describeProblem(problem);
}

/**
 * What a scan finding means and what the operator does about it. A finding is
 * NOT an error: the service answered; some findings book nothing (refused),
 * others book the goods and flag them (the carton is physically here).
 * `expected` / `actual` come from the service verbatim and are shown as-is.
 */
export interface FindingCopy {
  title: string;
  /** True when the goods are accepted despite the finding (the carton is still received). */
  booked: boolean;
  tone: Message["tone"];
  todo: string;
}

const FINDINGS: Record<string, FindingCopy> = {
  UnexpectedCarton: {
    title: "This carton is not on the delivery notice",
    booked: false,
    tone: "warning",
    todo: "Do not put it away. Set it aside in the problem area and tell your lead.",
  },
  MissingCarton: {
    title: "A carton on the delivery notice never arrived",
    booked: false,
    tone: "warning",
    todo: "Nothing to do on the dock. The receiving lead is told when the receipt closes.",
  },
  DuplicateSscc: {
    title: "This carton was already received",
    booked: false,
    tone: "warning",
    todo: "Do not count it again. If this is a second carton with the same label, set it aside and tell your lead.",
  },
  UnknownGtin: {
    title: "The system does not know that barcode",
    booked: false,
    tone: "warning",
    todo: "Set the goods aside in the problem area and tell your lead. Do not scan them again.",
  },
  CaseQtyMismatch: {
    title: "The quantity does not match the case",
    booked: false,
    tone: "warning",
    todo: "Count the items in the case. If it is a full case, scan it again; if not, scan the items one by one.",
  },
  MixedCaseDeclaredAsCasePack: {
    title: "The label says one product but the case holds something else",
    booked: false,
    tone: "warning",
    todo: "Open the case and check what is inside. Set it aside and tell your lead.",
  },
  UnlabelledCarton: {
    title: "This case has no carton label",
    booked: true,
    tone: "info",
    todo: "It was received and given a new label number. Print the label below and stick it on the case.",
  },
  CartonOverLimit: {
    title: "This carton is heavier or longer than the limit",
    booked: true,
    tone: "info",
    todo: "It was received. Handle it with two people or a lift, and tell the receiving lead.",
  },
  MixedCartonContentMismatch: {
    title: "What you counted differs from the carton label",
    booked: true,
    tone: "warning",
    todo: "The counted quantities were received, not the label's. Tell the receiving lead.",
  },
};

export function describeFinding(d: CartonDiscrepancy): FindingCopy {
  return (
    FINDINGS[d.kind] ?? {
      title: "The system flagged this scan",
      booked: false,
      tone: "warning",
      todo: `Set the goods aside and tell your lead. ${CALL_LEAD}`,
    }
  );
}

/** Kinds this build has copy for. */
export const FINDING_KINDS = Object.keys(FINDINGS);

/** A finding's `expected` / `actual` / `sscc` for display: the service's own text, nothing computed. */
export function findingFacts(d: CartonDiscrepancy): string[] {
  const out: string[] = [];
  if (d.sscc !== undefined) out.push(`Carton ${d.sscc}`);
  if (d.expected !== undefined) out.push(`Expected: ${d.expected}`);
  if (d.actual !== undefined) out.push(`Found: ${d.actual}`);
  return out;
}
