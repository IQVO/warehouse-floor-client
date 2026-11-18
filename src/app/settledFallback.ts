import { RECEIVING_BASE } from "../api/inboundReceiving";
import { describeProblem, type Message } from "../api/problemMessages";
import { YARD_BASE } from "../api/yardManagement";
import { describeReceivingSettled } from "../features/receiving/receivingSettled";
import { describeYardSettled } from "../features/yard/yardSettled";
import type { Outcome } from "../lib/commands";
import type { OutboxEntry } from "../lib/outbox";

/**
 * Words for a replayed answer that no screen showed, from the table of the context that owns the command (its
 * path says which). null: nothing the operator has to know. fulfillment-execution commands never get here:
 * `StationProvider` is always mounted and shows every one of them.
 */
export function describeSettled(entry: OutboxEntry, outcome: Outcome): Message | null {
  if (entry.path.startsWith(`${YARD_BASE}/`)) return describeYardSettled(entry, outcome);
  if (entry.path.startsWith(`${RECEIVING_BASE}/`)) return describeReceivingSettled(entry, outcome);
  if (outcome.state !== "problem") return null;
  const m = describeProblem(outcome.problem);
  return { ...m, what: `Saved action: ${m.what}` };
}

export interface SettledNotice extends Message {
  id: number;
  /** How many replayed answers said exactly this. */
  times: number;
}

/** Keeps every different message (a later answer never replaces an earlier one) and counts a repeated one. */
export function addSettledNotice(list: readonly SettledNotice[], message: Message): SettledNotice[] {
  const same = list.find((n) => n.what === message.what && n.todo === message.todo);
  if (same !== undefined) return list.map((n) => (n === same ? { ...n, times: n.times + 1 } : n));
  return [...list, { ...message, id: list.reduce((max, n) => Math.max(max, n.id), 0) + 1, times: 1 }];
}
