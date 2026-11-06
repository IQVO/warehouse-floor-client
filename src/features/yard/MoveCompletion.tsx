import { useState } from "react";
import { Card } from "@warehouse/ui-kit";
import type { Message } from "../../api/problemMessages";
import type { Outcome } from "../../lib/commands";
import type { Move, YardLocation, YardManagementApi } from "../../api/yardManagement";
import { ScanInput } from "../../components/ScanInput";
import { MoveFacts } from "./yardUi";
import { placeText } from "./yardFormat";
import { readYardCode } from "./yardScan";

/**
 * Completes one move with the place the trailer was actually left at, scanned
 * from the spot or door label. Used by the hostler (lease holder, sends
 * `hostlerRef`) and by the dock operator for a VISITING_DRIVER move (no
 * `hostlerRef`). A place other than the planned one needs a reason: the
 * service refuses it otherwise (`unexplained-destination`).
 */
export function MoveCompletion({
  move,
  unit,
  hostlerRef,
  api,
  title,
  onOutcome,
  onNotice,
}: {
  move: Move;
  unit?: string;
  /** Set for a HOSTLER move; omitted for a VISITING_DRIVER move. */
  hostlerRef?: string;
  api: YardManagementApi;
  title: string;
  onOutcome: (outcome: Outcome<Move>) => void;
  onNotice: (message: Message | null) => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [kind, setKind] = useState<YardLocation["kind"]>(move.to.kind);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const planned = code === move.to.code;
  const effectiveKind = planned ? move.to.kind : kind;
  const noteMissing = code !== null && !planned && note.trim() === "";

  function onScan(raw: string) {
    const read = readYardCode(raw, "location");
    if (!read.ok) {
      onNotice({ tone: "warning", what: read.message, todo: "Nothing was changed." });
      return;
    }
    onNotice(null);
    setCode(read.code);
    if (read.code === move.to.code) setNote("");
  }

  async function complete() {
    if (code === null || noteMissing) return;
    setBusy(true);
    try {
      onOutcome(
        await api.completeMove(move.moveId, {
          ...(hostlerRef === undefined ? {} : { hostlerRef }),
          actualLocation: { kind: effectiveKind, code },
          ...(planned ? {} : { deviationNote: note.trim() }),
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={title}>
      <MoveFacts move={move} unit={unit} />
      <ScanInput label="Scan the spot or door where the trailer is" hint={`Planned: ${placeText(move.to)}`} onScan={onScan} disabled={busy} />
      {code !== null && (
        <div className="floor-form">
          <p className={planned ? "floor-steps__done" : "floor-error"}>
            {planned ? `At the planned place: ${placeText(move.to)}.` : `Not the planned place. You scanned ${code}.`}
          </p>
          {!planned && (
            <>
              <fieldset className="floor-modes">
                <legend>What is {code}?</legend>
                {(["SPOT", "DOOR"] as const).map((k) => (
                  <label key={k}>
                    <input type="radio" name={`kind-${move.moveId}`} checked={kind === k} onChange={() => setKind(k)} /> {k === "SPOT" ? "A parking spot" : "A door"}
                  </label>
                ))}
              </fieldset>
              <div className="floor-field">
                <label htmlFor={`note-${move.moveId}`}>Why is it not at the planned place?</label>
                <input id={`note-${move.moveId}`} className="floor-input" value={note} autoComplete="off" onChange={(e) => setNote(e.target.value)} />
              </div>
            </>
          )}
          <button type="button" className="floor-btn floor-btn--primary floor-btn--xl" disabled={busy || noteMissing} onClick={() => void complete()}>
            Complete move
          </button>
        </div>
      )}
    </Card>
  );
}
