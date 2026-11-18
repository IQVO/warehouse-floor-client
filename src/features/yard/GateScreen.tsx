import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@warehouse/ui-kit";
import type { Message } from "../../api/problemMessages";
import { describeYardFailure } from "../../api/yardMessages";
import { yardManagementApi, type CheckIn } from "../../api/yardManagement";
import { useServices } from "../../app/servicesContext";
import type { Outcome } from "../../lib/commands";
import { problemCode } from "../../lib/problem";
import { CheckInForm } from "./CheckInForm";
import { emptyCheckIn, type CheckInDraft } from "./checkInRules";
import { CheckOutPanel } from "./CheckOutPanel";
import { RejectForm } from "./RejectForm";
import { withTurnAway, type TurnAway } from "./turnAway";
import { TurnedAway } from "./TurnedAway";
import { driverDirections } from "./yardFormat";
import { useYardPrefs, useYardSettled } from "./yardPrefs";
import { GATE_KINDS, gateDoneMessage } from "./yardSettled";
import { YardNotice, YardWho } from "./yardUi";

type Mode = "check-in" | "reject" | "check-out";
const MODES: { id: Mode; label: string }[] = [
  { id: "check-in", label: "Check in" },
  { id: "reject", label: "Reject" },
  { id: "check-out", label: "Check out" },
];

/** The site and plate a check-in carried (the `meta` of its outbox entry). */
interface Sent {
  siteId?: string | undefined;
  tractorPlate?: string | undefined;
}

/** The plate as `buildCheckIn` sends it. */
const plateOf = (draft: CheckInDraft): string => draft.tractorPlate.trim().toUpperCase();

/** /yard/gate: the gate clerk's three jobs. */
export function GateScreen() {
  const { runner } = useServices();
  const api = useMemo(() => yardManagementApi(runner), [runner]);
  const [prefs, setPrefs] = useYardPrefs();
  const [mode, setMode] = useState<Mode>("check-in");
  // What is typed for the truck at the gate. Held here, not in the form, because an answer for ANOTHER truck
  // (a saved check-in replayed) must be told apart from an answer for this one.
  const [draft, setDraft] = useState<CheckInDraft>(emptyCheckIn);
  const [notice, setNotice] = useState<Message | null>(null);
  const [admitted, setAdmitted] = useState<CheckIn | null>(null);
  const [turnedAway, setTurnedAway] = useState<TurnAway | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // The truck in the form right now, for answers that arrive later than the render that sent them.
  const inForm = useRef({ siteId: "", tractorPlate: "" });
  useEffect(() => {
    inForm.current = { siteId: prefs.siteId.trim(), tractorPlate: plateOf(draft) };
  });

  /**
   * One place turns an answer into screen state. `sent` is the site and plate the command carried: the truck the
   * clerk just submitted, or a saved check-in that was replayed (possibly an EARLIER truck than the one typed now).
   */
  const answered = useCallback((kind: string, outcome: Outcome, sent: Sent, reset?: () => void) => {
    const failure = describeYardFailure(outcome, kind === "yard-check-in" ? "check-in" : kind === "yard-reject" ? "rejection" : "check-out");
    // The one refusal that is not "nothing happened": the REJECTED visit is on record before the 409 is answered
    // (yard-management ADR 0016). If that truck is the one in the form, the truck is finished: the form is
    // cleared and goes, so nothing can send it a second time. If it is another truck (an earlier one, saved
    // offline), the turn-away is announced and the form, which holds a truck that was never sent, is left alone.
    if (kind === "yard-check-in" && failure !== null && outcome.state === "problem" && problemCode(outcome.problem) === "carrier-suspended") {
      const plate = sent.tractorPlate ?? "";
      const itsForm = plate !== "" && plate === inForm.current.tractorPlate && sent.siteId === inForm.current.siteId;
      if (itsForm) {
        setDraft(emptyCheckIn);
        setAdmitted(null);
      }
      setNotice(null);
      setTurnedAway((previous) => withTurnAway(previous, plate, failure, itsForm));
      return;
    }
    if (failure !== null || outcome.state !== "done") {
      setNotice(failure);
      return;
    }
    reset?.();
    setRefreshKey((k) => k + 1);
    setAdmitted(kind === "yard-check-in" ? (outcome.data as CheckIn) : null);
    setNotice(gateDoneMessage(kind, outcome.data));
  }, []);

  // A command saved offline (or before a reload) is answered later by a replay: show that answer too.
  useYardSettled((entry, outcome) => {
    if (!GATE_KINDS.includes(entry.kind)) return false;
    answered(entry.kind, outcome, { siteId: entry.meta.siteId, tractorPlate: entry.meta.tractorPlate });
    return true;
  });

  /** Leaving the check-in job drops what was typed for it, as it always did. */
  function choose(next: Mode) {
    if (next !== mode && mode === "check-in") setDraft(emptyCheckIn);
    setMode(next);
  }

  return (
    <div className="floor-stack">
      <YardWho prefs={prefs} onChange={setPrefs} />
      <YardNotice message={notice} onDismiss={() => setNotice(null)} />
      {turnedAway !== null && <TurnedAway turnAway={turnedAway} onNext={() => setTurnedAway(null)} />}
      <fieldset className="floor-modes">
        <legend className="floor-muted">At the gate</legend>
        {MODES.map((m) => (
          <button key={m.id} type="button" className={`floor-btn${mode === m.id ? " floor-btn--primary" : ""}`} aria-pressed={mode === m.id} onClick={() => choose(m.id)}>
            {m.label}
          </button>
        ))}
      </fieldset>

      {/* Not shown once the truck in the form was turned away (it was cleared then): the next truck starts with the card's button. */}
      {mode === "check-in" && turnedAway?.blocking !== true && (
        <CheckInForm
          siteId={prefs.siteId}
          api={api}
          draft={draft}
          onDraft={setDraft}
          onNotice={setNotice}
          // The plate that was SENT, not the one in the form by now: the clerk may have typed on while the request was out.
          onOutcome={(o, plate) => answered("yard-check-in", o, { siteId: prefs.siteId.trim(), tractorPlate: plate }, () => setDraft((d) => (plateOf(d) === plate ? emptyCheckIn : d)))}
        />
      )}
      {mode === "reject" && <RejectForm siteId={prefs.siteId} api={api} onNotice={setNotice} onOutcome={(o, reset) => answered("yard-reject", o, {}, reset)} />}
      {mode === "check-out" && <CheckOutPanel key={`${prefs.siteId}:${refreshKey}`} siteId={prefs.siteId} api={api} onNotice={setNotice} onOutcome={(o) => answered("yard-check-out", o, {})} />}

      {admitted !== null && admitted.visit.state !== "REJECTED" && (
        <Card title="Where the driver goes">
          {admitted.moves.length === 0 && <p>No trailer to place.</p>}
          <ul className="floor-steps">
            {driverDirections(admitted).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="floor-muted">The dock operator confirms the arrival on the Dock screen.</p>
        </Card>
      )}
    </div>
  );
}
