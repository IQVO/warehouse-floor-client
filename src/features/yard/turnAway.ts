import type { Message } from "../../api/problemMessages";

/** The trucks the service turned away at check-in and already put on record (yard-management ADR 0016). */
export interface TurnAway {
  /** The plates as they were sent, oldest first. Several when saved check-ins were answered one after another. */
  tractorPlates: string[];
  message: Message;
}

/** Adds one more turned-away truck: no plate is named twice, and a command that carried none adds none. */
export function withTurnAway(previous: TurnAway | null, tractorPlate: string, message: Message): TurnAway {
  const plates = (previous?.tractorPlates ?? []).filter((p) => p !== tractorPlate);
  return { tractorPlates: tractorPlate === "" ? plates : [...plates, tractorPlate], message };
}

export function turnAwayTitle(plates: string[]): string {
  if (plates.length === 0) return "This truck is turned away";
  return plates.length === 1 ? `${plates[0]} is turned away` : `Turned away: ${plates.join(", ")}`;
}
