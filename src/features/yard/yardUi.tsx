import { useId } from "react";
import { Card } from "@warehouse/ui-kit";
import type { Message } from "../../api/problemMessages";
import type { Move } from "../../api/yardManagement";
import { dueText, placeText, reasonText } from "./yardFormat";
import type { YardPrefs } from "./yardPrefs";

/** What a message is for: warnings and dangers interrupt (alert), the rest is a status. */
export function YardNotice({ message, onDismiss }: { message: Message | null; onDismiss?: () => void }) {
  if (message === null) return null;
  return (
    <div className={`floor-notice floor-notice--${message.tone}`} role={message.tone === "danger" || message.tone === "warning" ? "alert" : "status"}>
      <p className="floor-notice__what">{message.what}</p>
      <p className="floor-notice__todo">{message.todo}</p>
      {onDismiss && (
        <button type="button" className="floor-btn floor-btn--quiet" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

/** The site this device works at (and, for a hostler, who is driving). Kept on the device. */
export function YardWho({ prefs, onChange, hostler = false }: { prefs: YardPrefs; onChange: (patch: Partial<YardPrefs>) => void; hostler?: boolean }) {
  const siteId = useId();
  const hostlerId = useId();
  return (
    <Card title="Where you work">
      <div className="floor-form">
        <div className="floor-field">
          <label htmlFor={siteId}>Site code</label>
          <input id={siteId} className="floor-input" value={prefs.siteId} autoComplete="off" onChange={(e) => onChange({ siteId: e.target.value.trim() })} />
        </div>
        {hostler && (
          <div className="floor-field">
            <label htmlFor={hostlerId}>Your hostler id</label>
            <input id={hostlerId} className="floor-input" value={prefs.hostlerRef} autoComplete="off" onChange={(e) => onChange({ hostlerRef: e.target.value.trim() })} />
          </div>
        )}
      </div>
    </Card>
  );
}

export function MoveFacts({ move, unit }: { move: Move; unit?: string }) {
  return (
    <dl className="floor-facts">
      <dt>Trailer</dt>
      <dd>{unit ?? move.trailerId}</dd>
      <dt>From</dt>
      <dd>{placeText(move.from)}</dd>
      <dt>To</dt>
      <dd>{placeText(move.to)}</dd>
      <dt>Why</dt>
      <dd>{reasonText(move.reason)}</dd>
      <dt>Due</dt>
      <dd>{dueText(move)}</dd>
    </dl>
  );
}
