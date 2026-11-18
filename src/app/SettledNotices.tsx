import { useEffect, useState } from "react";
import { addSettledNotice, describeSettled, type SettledNotice } from "./settledFallback";
import { useServices } from "./servicesContext";

/**
 * The answers of replayed commands that no screen showed, above every screen.
 *
 * A command saved offline can be answered minutes later, when its own screen
 * is no longer in view; by then the entry has left the outbox, so this is the
 * only place left to say it. Each notice stays until it is dismissed, and a
 * later one never replaces it.
 */
export function SettledNotices() {
  const { runner } = useServices();
  const [notices, setNotices] = useState<SettledNotice[]>([]);

  useEffect(
    () =>
      runner.onUnhandledSettled((entry, outcome) => {
        const message = describeSettled(entry, outcome);
        if (message !== null) setNotices((list) => addSettledNotice(list, message));
      }),
    [runner],
  );

  return notices.map((n) => (
    <div key={n.id} className={`floor-notice floor-notice--${n.tone}`} role={n.tone === "danger" || n.tone === "warning" ? "alert" : "status"}>
      <p className="floor-notice__what">{n.what}</p>
      <p className="floor-notice__todo">{n.todo}</p>
      {n.times > 1 && <p className="floor-muted">This happened {n.times} times.</p>}
      <button type="button" className="floor-btn floor-btn--quiet" onClick={() => setNotices((list) => list.filter((x) => x.id !== n.id))}>
        Dismiss
      </button>
    </div>
  ));
}
