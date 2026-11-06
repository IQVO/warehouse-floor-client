import { formatCountdown } from "../../lib/format";

/**
 * The lease on a claimed move. yard-management has no renewal call: the lease
 * is fixed when the move is claimed, and a move not completed by then goes back
 * to the queue on the service's lease sweep. So this says so, instead of the
 * "renews automatically" of a station's task lease.
 */
export function MoveLease({ remainingMs }: { remainingMs: number | null }) {
  if (remainingMs === null) {
    return (
      <div className="floor-lease floor-lease--warning">
        <span className="floor-lease__label">Lease</span>
        <span className="floor-lease__time">—</span>
        <span className="floor-lease__note">The system gave no end time. Finish the move as soon as you can.</span>
      </div>
    );
  }
  const expired = remainingMs <= 0;
  const tone = expired ? "danger" : remainingMs < 60_000 ? "warning" : "ok";
  return (
    <div className={`floor-lease floor-lease--${tone}`}>
      <span className="floor-lease__label">Lease</span>
      <span className="floor-lease__time" role="timer" aria-label="Time left on your claim">
        {formatCountdown(remainingMs)}
      </span>
      <span className="floor-lease__note">
        {expired
          ? "Your time has run out. The move may already be back in the queue. Complete it only if you still have the trailer."
          : "It cannot be extended. Finish the move before it ends, or it goes back in the queue."}
      </span>
    </div>
  );
}
