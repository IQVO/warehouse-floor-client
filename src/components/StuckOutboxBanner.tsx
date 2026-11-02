import { usePendingCommands, useServices } from "../app/servicesContext";

/**
 * Always-visible notice for saved actions that gave up: the per-entry attempt
 * cap was hit, they are no longer retried automatically, and only the operator
 * can clear them — retry (same Idempotency-Key, so no double-apply) or
 * discard. Without this the operator's confirmation would sit unreported.
 */
export function StuckOutboxBanner() {
  const pending = usePendingCommands();
  const { outbox, runner } = useServices();
  const stuck = pending.filter((e) => e.stuck === true);
  if (stuck.length === 0) return null;

  const one = stuck.length === 1;
  return (
    <div className="floor-banner floor-banner--stuck" role="alert">
      <div>
        <strong>{one ? "1 saved action could not be sent" : `${stuck.length} saved actions could not be sent`}</strong>
        <span>
          {one ? " It stopped after repeated failures and will not retry on its own."
            : " They stopped after repeated failures and will not retry on their own."}{" "}
          Send again or discard.
        </span>
      </div>
      <div className="floor-banner__actions">
        <button
          type="button"
          className="floor-btn"
          onClick={() => {
            for (const entry of stuck) outbox.retry(entry.key);
            void runner.flush();
          }}
        >
          Send again
        </button>
        <button
          type="button"
          className="floor-btn"
          onClick={() => {
            for (const entry of stuck) outbox.remove(entry.key);
          }}
        >
          Discard
        </button>
      </div>
    </div>
  );
}
