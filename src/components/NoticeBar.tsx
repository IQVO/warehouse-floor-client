import { useStation } from "../features/station/stationState";

/** The result of the operator's last action, in plain words: what happened and what to do. */
export function NoticeBar() {
  const { notice, dismissNotice } = useStation();
  if (notice === null) return null;
  return (
    <div
      className={`floor-notice floor-notice--${notice.tone}`}
      role={notice.tone === "danger" || notice.tone === "warning" ? "alert" : "status"}
    >
      <p className="floor-notice__what">{notice.what}</p>
      <p className="floor-notice__todo">{notice.todo}</p>
      <button type="button" className="floor-btn floor-btn--quiet" onClick={dismissNotice}>
        Dismiss
      </button>
    </div>
  );
}
