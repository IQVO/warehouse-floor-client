import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@warehouse/ui-kit";
import type { Message } from "../../api/problemMessages";
import { describeYardFailure, describeYardReadFailure } from "../../api/yardMessages";
import { yardManagementApi, yardReads, type LoadState, type Move, type Trailer } from "../../api/yardManagement";
import { useServices } from "../../app/servicesContext";
import { ScanInput } from "../../components/ScanInput";
import type { Outcome } from "../../lib/commands";
import { DoorWorkCard } from "./DoorWorkCard";
import { MoveCompletion } from "./MoveCompletion";
import { placeText, reasonText } from "./yardFormat";
import { useYardPrefs, useYardSettled } from "./yardPrefs";
import { readYardCode } from "./yardScan";
import { YardNotice, YardWho } from "./yardUi";

interface Snapshot {
  trailers: Trailer[];
  moves: Move[];
}

/** /yard/dock: trailers at doors with their door work, and the drivers who bring their own trailer to a place. */
export function DockScreen() {
  const { runner, fetchFn } = useServices();
  const api = useMemo(() => yardManagementApi(runner), [runner]);
  const [prefs, setPrefs] = useYardPrefs();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<Message | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [arriving, setArriving] = useState<string | null>(null);

  const { siteId } = prefs;
  useEffect(() => {
    if (siteId === "") return;
    let live = true;
    void Promise.all([yardReads.listTrailers({ siteId }, fetchFn()), yardReads.listMoves({ siteId, state: "CLAIMED" }, fetchFn())]).then(([t, m]) => {
      if (!live) return;
      if (t.state !== "done") setNotice(describeYardReadFailure(t, "the trailers"));
      else if (m.state !== "done") setNotice(describeYardReadFailure(m, "the moves"));
      else setSnap({ trailers: t.data, moves: m.data });
    });
    return () => {
      live = false;
    };
  }, [siteId, fetchFn, reload]);

  const answered = useCallback((kind: string, outcome: Outcome) => {
    const label = kind === "yard-complete-move" ? "arrival" : "door work";
    const failure = describeYardFailure(outcome, label);
    if (failure !== null || outcome.state !== "done") {
      setNotice(failure);
      return;
    }
    if (kind === "yard-complete-move") {
      const done = outcome.data as Move;
      setArriving(null);
      setReload((n) => n + 1);
      setNotice({ tone: "success", what: `The trailer is at ${done.actualLocation?.code ?? done.to.code}.`, todo: "Start door work when it is at a door." });
      return;
    }
    const t = outcome.data as Trailer;
    setSnap((s) => (s === null ? s : { ...s, trailers: s.trailers.map((x) => (x.trailerId === t.trailerId ? t : x)) }));
    setNotice(
      kind === "yard-door-start"
        ? { tone: "success", what: `Door work started on ${t.unitNumber}.`, todo: "Complete it when the last pallet is off or on." }
        : { tone: "success", what: `Door work done on ${t.unitNumber}.`, todo: "A drop trailer is moved off the door by a hostler; a live truck leaves from the door." },
    );
  }, []);

  useYardSettled((entry, outcome) => {
    if (["yard-door-start", "yard-door-complete", "yard-complete-move"].includes(entry.kind)) answered(entry.kind, outcome);
  });

  async function run(kind: string, command: () => Promise<Outcome>) {
    setBusy(true);
    try {
      answered(kind, await command());
    } finally {
      setBusy(false);
    }
  }

  function onScan(raw: string) {
    const read = readYardCode(raw, "location");
    if (!read.ok) {
      setNotice({ tone: "warning", what: read.message, todo: "Nothing was changed." });
      return;
    }
    const code = read.code.toLowerCase();
    const hit = (snap?.trailers ?? []).find((t) => t.state === "DOCKED" && (t.location?.code.toLowerCase() === code || t.unitNumber.toLowerCase() === code));
    if (hit === undefined) {
      setNotice({ tone: "warning", what: `No trailer is docked at, or numbered, ${read.code}.`, todo: "Scan the door label or the trailer's unit number again." });
      return;
    }
    setNotice(null);
    setFilter(hit.trailerId);
  }

  const docked = (snap?.trailers ?? []).filter((t) => t.state === "DOCKED").sort((a, b) => (a.location?.code ?? "").localeCompare(b.location?.code ?? ""));
  const shown = filter === null ? docked : docked.filter((t) => t.trailerId === filter);
  const visiting = (snap?.moves ?? []).filter((m) => m.performer === "VISITING_DRIVER");
  const unitOf = (id: string) => snap?.trailers.find((t) => t.trailerId === id)?.unitNumber;
  const chosen = visiting.find((m) => m.moveId === arriving);

  return (
    <div className="floor-stack">
      <YardWho prefs={prefs} onChange={setPrefs} />
      <YardNotice message={notice} onDismiss={() => setNotice(null)} />
      {siteId === "" && <p>Enter the site code first.</p>}
      {siteId !== "" && snap === null && notice === null && <p>Loading the doors...</p>}
      {snap !== null && (
        <>
          <Card title="Trailers at doors">
            <ScanInput label="Scan a door or a trailer" hint="Shows that trailer only" onScan={onScan} disabled={busy} />
            <div className="floor-form">
              {filter !== null && (
                <button type="button" className="floor-btn floor-btn--quiet" onClick={() => setFilter(null)}>
                  Show all doors
                </button>
              )}
              <button type="button" className="floor-btn floor-btn--quiet" disabled={busy} onClick={() => setReload((n) => n + 1)}>
                Refresh
              </button>
              {docked.length === 0 && <p>No trailer is at a door right now.</p>}
            </div>
          </Card>
          {shown.map((t) => (
            <DoorWorkCard
              key={`${t.trailerId}:${t.version}`}
              trailer={t}
              busy={busy}
              onStart={() => void run("yard-door-start", () => api.startDoorWork(t.trailerId))}
              onComplete={(loadState: LoadState | undefined) => void run("yard-door-complete", () => api.completeDoorWork(t.trailerId, loadState))}
            />
          ))}

          <Card title="Drivers bringing their own trailer">
            {visiting.length === 0 && <p>No driver is on the way to a place.</p>}
            <ul className="floor-steps">
              {visiting.map((m) => (
                <li key={m.moveId}>
                  <button type="button" className="floor-btn" aria-pressed={arriving === m.moveId} onClick={() => setArriving(m.moveId)}>
                    {unitOf(m.trailerId) ?? m.trailerId}
                  </button>{" "}
                  to {placeText(m.to)} ({reasonText(m.reason)})
                </li>
              ))}
            </ul>
          </Card>
          {chosen !== undefined && (
            <MoveCompletion key={chosen.moveId} move={chosen} unit={unitOf(chosen.trailerId)} api={api} title="Confirm the arrival" onNotice={setNotice} onOutcome={(o) => answered("yard-complete-move", o)} />
          )}
        </>
      )}
    </div>
  );
}
