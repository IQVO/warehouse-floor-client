import { formatCountdown } from "../lib/format";

/**
 * Visible lease countdown. The lease is renewed automatically while this
 * screen's session is alive; the countdown shows how long the claim would last
 * if renewal stopped, and says so plainly if renewal is failing.
 */
export function LeaseCountdown({
  remainingMs,
  durationMs,
  renewFailing,
}: {
  remainingMs: number;
  durationMs: number;
  renewFailing: boolean;
}) {
  const expired = remainingMs <= 0;
  const tone = expired ? "danger" : renewFailing || remainingMs < Math.min(60_000, durationMs / 4) ? "warning" : "ok";
  return (
    <div className={`floor-lease floor-lease--${tone}`}>
      <span className="floor-lease__label">Lease</span>
      <span className="floor-lease__time" role="timer" aria-label="Time left on your claim">
        {formatCountdown(remainingMs)}
      </span>
      <span className="floor-lease__note">
        {expired
          ? "Your claim has run out. The task may already be back in the pool."
          : renewFailing
            ? "Could not renew. Reconnect soon or the task goes back to the pool."
            : "Renews automatically."}
      </span>
    </div>
  );
}
