import { useCallback, useMemo, useState } from "react";
import { Card } from "@warehouse/ui-kit";
import type { Message } from "../../api/problemMessages";
import { describeYardFailure } from "../../api/yardMessages";
import { yardManagementApi, type CheckIn, type Visit } from "../../api/yardManagement";
import { useServices } from "../../app/servicesContext";
import type { Outcome } from "../../lib/commands";
import { CheckInForm } from "./CheckInForm";
import { CheckOutPanel } from "./CheckOutPanel";
import { RejectForm } from "./RejectForm";
import { REJECTION_TEXT, placeText, reasonText } from "./yardFormat";
import { useYardPrefs, useYardSettled } from "./yardPrefs";
import { YardNotice, YardWho } from "./yardUi";

type Mode = "check-in" | "reject" | "check-out";
const MODES: { id: Mode; label: string }[] = [
  { id: "check-in", label: "Check in" },
  { id: "reject", label: "Reject" },
  { id: "check-out", label: "Check out" },
];

/** /yard/gate: the gate clerk's three jobs. */
export function GateScreen() {
  const { runner } = useServices();
  const api = useMemo(() => yardManagementApi(runner), [runner]);
  const [prefs, setPrefs] = useYardPrefs();
  const [mode, setMode] = useState<Mode>("check-in");
  const [notice, setNotice] = useState<Message | null>(null);
  const [admitted, setAdmitted] = useState<CheckIn | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const answered = useCallback((kind: string, outcome: Outcome, reset?: () => void) => {
    const failure = describeYardFailure(outcome, kind === "yard-check-in" ? "check-in" : kind === "yard-reject" ? "rejection" : "check-out");
    if (failure !== null || outcome.state !== "done") {
      setNotice(failure);
      return;
    }
    reset?.();
    setRefreshKey((k) => k + 1);
    if (kind === "yard-check-in") {
      const result = outcome.data as CheckIn;
      setAdmitted(result);
      setNotice(
        result.visit.state === "REJECTED"
          ? { tone: "warning", what: `Turned away: ${REJECTION_TEXT[result.visit.rejectionReason ?? "SITE_REQUEST"]}.`, todo: "The truck does not enter. Tell the driver." }
          : { tone: "success", what: `${result.visit.tractorPlate} is checked in.`, todo: "Tell the driver where to take each trailer (below)." },
      );
    } else if (kind === "yard-reject") {
      setAdmitted(null);
      setNotice({ tone: "success", what: `${(outcome.data as Visit).tractorPlate} was turned away and the refusal is recorded.`, todo: "Tell the driver." });
    } else {
      setAdmitted(null);
      setNotice({ tone: "success", what: `${(outcome.data as Visit).tractorPlate} is checked out.`, todo: "Open the gate." });
    }
  }, []);

  // A command saved offline (or before a reload) is answered later by a replay: show that answer too.
  useYardSettled((entry, outcome) => {
    if (["yard-check-in", "yard-reject", "yard-check-out"].includes(entry.kind)) answered(entry.kind, outcome);
  });

  return (
    <div className="floor-stack">
      <YardWho prefs={prefs} onChange={setPrefs} />
      <YardNotice message={notice} onDismiss={() => setNotice(null)} />
      <fieldset className="floor-modes">
        <legend className="floor-muted">At the gate</legend>
        {MODES.map((m) => (
          <button key={m.id} type="button" className={`floor-btn${mode === m.id ? " floor-btn--primary" : ""}`} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </fieldset>

      {mode === "check-in" && <CheckInForm siteId={prefs.siteId} api={api} onNotice={setNotice} onOutcome={(o, reset) => answered("yard-check-in", o, reset)} />}
      {mode === "reject" && <RejectForm siteId={prefs.siteId} api={api} onNotice={setNotice} onOutcome={(o, reset) => answered("yard-reject", o, reset)} />}
      {mode === "check-out" && <CheckOutPanel key={`${prefs.siteId}:${refreshKey}`} siteId={prefs.siteId} api={api} onNotice={setNotice} onOutcome={(o) => answered("yard-check-out", o)} />}

      {admitted !== null && admitted.visit.state !== "REJECTED" && (
        <Card title="Where the driver goes">
          {admitted.moves.length === 0 && <p>No trailer to place.</p>}
          <ul className="floor-steps">
            {admitted.moves.map((m) => {
              const unit = admitted.trailers.find((t) => t.trailerId === m.trailerId)?.unitNumber ?? m.trailerId;
              return (
                <li key={m.moveId}>
                  Take {unit} to {placeText(m.to)} ({reasonText(m.reason)}).
                </li>
              );
            })}
          </ul>
          <p className="floor-muted">The dock operator confirms the arrival on the Dock screen.</p>
        </Card>
      )}
    </div>
  );
}
