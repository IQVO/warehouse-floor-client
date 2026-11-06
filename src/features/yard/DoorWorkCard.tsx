import { useState } from "react";
import { Card } from "@warehouse/ui-kit";
import { LOAD_STATES, type LoadState, type Trailer } from "../../api/yardManagement";
import { placeText } from "./yardFormat";

const LOAD_TEXT: Record<LoadState, string> = { EMPTY: "Empty", LOADED: "Loaded", PARTIAL: "Part loaded" };
const HOLD_TEXT: Record<string, string> = {
  DAMAGED: "damaged",
  SEAL_BROKEN: "seal broken",
  NOT_FOUND: "trailer not found",
  QUALITY: "quality",
  SECURITY: "security",
};

/** What the trailer most likely holds when the work ends: the service accepts any of the three, or none (it keeps the state). */
function suggestedLoadState(t: Trailer): LoadState | "" {
  if (t.asnNumbers.length > 0) return "EMPTY";
  if (t.outboundRef) return "LOADED";
  return "";
}

/** One trailer at a door, with the door-work step it is at. The service decides what is allowed; this only offers the next step. */
export function DoorWorkCard({
  trailer,
  busy,
  onStart,
  onComplete,
}: {
  trailer: Trailer;
  busy: boolean;
  onStart: () => void;
  onComplete: (loadState: LoadState | undefined) => void;
}) {
  const [loadState, setLoadState] = useState<LoadState | "">(() => suggestedLoadState(trailer));
  const held = trailer.hold !== null && trailer.hold !== undefined;
  const hold = trailer.hold ? (HOLD_TEXT[trailer.hold] ?? trailer.hold) : null;
  const selectId = `load-after-${trailer.trailerId}`;
  return (
    <Card title={`${placeText(trailer.location)}: ${trailer.unitNumber}`}>
      <dl className="floor-facts">
        <dt>Load</dt>
        <dd>{LOAD_TEXT[trailer.loadState]}</dd>
        <dt>Seal</dt>
        <dd>{trailer.seal.number ?? "—"}</dd>
        <dt>Door work</dt>
        <dd>{trailer.doorWork === "WAITING" ? "Waiting" : trailer.doorWork === "IN_PROGRESS" ? "In progress" : trailer.doorWork === "DONE" ? "Done" : "—"}</dd>
        {trailer.asnNumbers.length > 0 && (
          <>
            <dt>Delivery notices</dt>
            <dd>{trailer.asnNumbers.join(", ")}</dd>
          </>
        )}
      </dl>
      {hold !== null && <p className="floor-error">On hold ({hold}). Door work waits until your lead releases it.</p>}
      {trailer.doorWork === "WAITING" && (
        <button type="button" className="floor-btn floor-btn--primary floor-btn--xl" disabled={busy || held} onClick={onStart}>
          Start door work on {trailer.unitNumber}
        </button>
      )}
      {trailer.doorWork === "IN_PROGRESS" && (
        <div className="floor-form">
          <div className="floor-field">
            <label htmlFor={selectId}>Load state when finished ({trailer.unitNumber})</label>
            <select id={selectId} className="floor-input" value={loadState} onChange={(e) => setLoadState(e.target.value as LoadState | "")}>
              <option value="">Leave as it is</option>
              {LOAD_STATES.map((l) => (
                <option key={l} value={l}>
                  {LOAD_TEXT[l]}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="floor-btn floor-btn--primary floor-btn--xl" disabled={busy} onClick={() => onComplete(loadState === "" ? undefined : loadState)}>
            Complete door work on {trailer.unitNumber}
          </button>
        </div>
      )}
    </Card>
  );
}
