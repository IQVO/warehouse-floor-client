import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../../app/servicesContext";
import type { Outcome } from "../../lib/commands";
import type { OutboxEntry } from "../../lib/outbox";
import type { KeyValueStore } from "../../lib/storage";

export const YARD_PREFS_KEY = "wfc.yard.v1";

/** Who is at the screen: the site every yard call is scoped to, and the hostler's own reference. */
export interface YardPrefs {
  siteId: string;
  hostlerRef: string;
}

export function loadYardPrefs(store: KeyValueStore): YardPrefs {
  const empty: YardPrefs = { siteId: "", hostlerRef: "" };
  try {
    const raw = store.getItem(YARD_PREFS_KEY);
    if (raw === null) return empty;
    const v = JSON.parse(raw) as Partial<YardPrefs>;
    return { siteId: typeof v.siteId === "string" ? v.siteId : "", hostlerRef: typeof v.hostlerRef === "string" ? v.hostlerRef : "" };
  } catch {
    return empty;
  }
}

/** The site code / hostler reference of this device, kept in the same store as the outbox. */
export function useYardPrefs(): [YardPrefs, (patch: Partial<YardPrefs>) => void] {
  const { store } = useServices();
  const [prefs, setPrefs] = useState(() => loadYardPrefs(store));
  const update = useCallback(
    (patch: Partial<YardPrefs>) => {
      setPrefs((p) => {
        const next = { ...p, ...patch };
        store.setItem(YARD_PREFS_KEY, JSON.stringify(next));
        return next;
      });
    },
    [store],
  );
  return [prefs, update];
}

/**
 * Hands the screen the answer of every yard command that was settled by a
 * REPLAY (offline, lost answer, reload), so it shows that answer exactly as it
 * would for a direct tap. Direct submits are handled where they are awaited.
 */
export function useYardSettled(handler: (entry: OutboxEntry, outcome: Outcome) => void): void {
  const { runner } = useServices();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(
    () =>
      runner.onSettled((entry, outcome) => {
        if (entry.kind.startsWith("yard-")) latest.current(entry, outcome);
      }),
    [runner],
  );
}
