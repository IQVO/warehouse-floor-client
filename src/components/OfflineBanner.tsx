import { useOnline, usePendingCommands, useServices } from "../app/servicesContext";

/**
 * Always-visible offline notice. Shown while the network is believed down; it
 * stays up (with a "Retry now") as long as saved commands are still waiting,
 * so an operator never has to wonder whether their last confirmation was lost.
 */
export function OfflineBanner() {
  const online = useOnline();
  const pending = usePendingCommands();
  const { runner } = useServices();

  if (online && pending.length === 0) return null;

  const waiting = pending.length;
  return (
    <div className={online ? "floor-banner floor-banner--pending" : "floor-banner floor-banner--offline"} role="alert">
      <div>
        <strong>{online ? "Sending saved actions" : "You are offline"}</strong>
        <span>
          {online
            ? ` ${waiting} saved ${waiting === 1 ? "action is" : "actions are"} waiting to be sent.`
            : waiting > 0
              ? ` ${waiting} ${waiting === 1 ? "action is" : "actions are"} saved on this device and will be sent when the connection returns.`
              : " Actions you confirm are saved on this device and will be sent when the connection returns."}
        </span>
      </div>
      <button type="button" className="floor-btn" onClick={() => void runner.flush()}>
        Retry now
      </button>
    </div>
  );
}
