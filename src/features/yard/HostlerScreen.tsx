import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@warehouse/ui-kit";
import type { Message } from "../../api/problemMessages";
import { describeYardFailure } from "../../api/yardMessages";
import { yardManagementApi, yardReads, type Move } from "../../api/yardManagement";
import { usePendingCommands, useServices } from "../../app/servicesContext";
import type { Outcome } from "../../lib/commands";
import { log } from "../../lib/log";
import { problemCode } from "../../lib/problem";
import { leaseDeadline, loadHeld, saveHeld, type HeldMove } from "./hostlerState";
import { MoveCompletion } from "./MoveCompletion";
import { MoveLease } from "./MoveLease";
import { useYardPrefs, useYardSettled } from "./yardPrefs";
import { YardNotice, YardWho } from "./yardUi";

/** Answers after which the move is no longer this hostler's to complete. */
const GONE = ["not-lease-holder", "illegal-transition", "move-not-found"];

/** /yard/hostler: claim the next move, see it, complete it with the place the trailer was left at. */
export function HostlerScreen() {
  const { runner, store, fetchFn, now: clock } = useServices();
  const api = useMemo(() => yardManagementApi(runner), [runner]);
  const pendingCompletes = usePendingCommands().filter((e) => e.kind === "yard-complete-move");
  const [prefs, setPrefs] = useYardPrefs();
  const [held, setHeld] = useState<HeldMove | null>(() => loadHeld(store));
  const [notice, setNotice] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => clock());
  const heldRef = useRef(held);
  const pendingRef = useRef(pendingCompletes);

  useEffect(() => {
    heldRef.current = held;
    pendingRef.current = pendingCompletes;
  });
  useEffect(() => saveHeld(store, held), [store, held]);

  // The countdown ticks once a second while a move is held.
  const holding = held !== null;
  useEffect(() => {
    if (!holding) return;
    const timer = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(timer);
  }, [holding, clock]);

  const adopt = useCallback(
    (move: Move, serverTime: number | undefined) => {
      const next: HeldMove = { move, leaseDeadline: leaseDeadline(move.leaseExpiresAt, serverTime, clock()) };
      setHeld(next);
      setNow(clock());
      // The claim answer carries the trailer id only; the unit number is what the hostler looks for in the yard.
      void yardReads.getTrailer(move.trailerId, fetchFn()).then((r) => {
        if (r.state === "done") setHeld((h) => (h?.move.moveId === move.moveId ? { ...h, unit: r.data.unitNumber } : h));
      });
    },
    [clock, fetchFn],
  );

  // One place turns an answer into screen state: a direct tap and a replayed command take the same path.
  const answered = useCallback(
    (kind: string, outcome: Outcome, meta: Record<string, string>, replayed: boolean) => {
      const failure = describeYardFailure(outcome, kind === "yard-claim" ? "claim" : "move completion");
      if (outcome.state === "problem") {
        const code = problemCode(outcome.problem);
        log.warn("yard command rejected", kind, outcome.status, code);
        if (kind === "yard-complete-move" && GONE.includes(code)) setHeld((h) => (h?.move.moveId === meta.moveId ? null : h));
        if (kind === "yard-claim" && code === "hostler-busy") {
          setNotice({ tone: "warning", what: "You already hold a move.", todo: "Reload this screen to see it, or ask your lead to release it." });
          return;
        }
      }
      if (failure !== null || outcome.state !== "done") {
        setNotice(failure);
        return;
      }
      if (kind === "yard-claim") {
        const move = outcome.data as Move;
        if (heldRef.current !== null && replayed) {
          // A claim replayed after reconnect landed while a move is already in hand: the extra lease lapses by itself.
          setNotice({ tone: "warning", what: "An extra move was claimed when the connection came back.", todo: "Ignore it: it returns to the queue by itself. Carry on with your current move." });
          return;
        }
        adopt(move, outcome.serverTime);
        setNotice({ tone: "success", what: "A move is yours.", todo: "Take the trailer to the place shown, then scan that place to complete." });
      } else {
        const done = outcome.data as Move;
        setHeld((h) => (h?.move.moveId === done.moveId ? null : h));
        setNotice({ tone: "success", what: `Move done. The trailer is at ${done.actualLocation?.code ?? done.to.code}.`, todo: "Claim the next move when you are ready." });
      }
    },
    [adopt],
  );

  useYardSettled((entry, outcome) => {
    if (entry.kind === "yard-claim" || entry.kind === "yard-complete-move") answered(entry.kind, outcome, entry.meta, true);
  });

  // After a reload or a lost answer, ask the service which move this hostler holds: it is the truth.
  const { siteId, hostlerRef } = prefs;
  useEffect(() => {
    if (siteId === "" || hostlerRef === "") return;
    let live = true;
    void yardReads.listMoves({ siteId, state: "CLAIMED" }, fetchFn()).then((r) => {
      if (!live || r.state !== "done") return;
      const mine = r.data.find((m) => m.performer === "HOSTLER" && m.hostlerRef === hostlerRef);
      const current = heldRef.current;
      if (mine !== undefined && current === null) adopt(mine, undefined);
      else if (mine === undefined && current !== null && !pendingRef.current.some((e) => e.meta.moveId === current.move.moveId)) {
        setHeld(null);
        setNotice({ tone: "info", what: "You no longer hold that move: it went back to the queue or was finished.", todo: "Claim the next move." });
      }
    });
    return () => {
      live = false;
    };
  }, [siteId, hostlerRef, fetchFn, adopt]);

  async function claim() {
    if (siteId === "" || hostlerRef === "") {
      setNotice({ tone: "warning", what: "Enter the site code and your hostler id first.", todo: "Nothing was sent." });
      return;
    }
    setBusy(true);
    try {
      answered("yard-claim", await api.claimNextMove(siteId, hostlerRef), {}, false);
    } finally {
      setBusy(false);
    }
  }

  const remaining = held?.leaseDeadline == null ? null : held.leaseDeadline - now;
  return (
    <div className="floor-stack">
      <YardWho prefs={prefs} onChange={setPrefs} hostler />
      <YardNotice message={notice} onDismiss={() => setNotice(null)} />
      {held === null ? (
        <Card title="Next move">
          <p>Moves are given to you by the system, highest priority first.</p>
          <button type="button" className="floor-btn floor-btn--primary floor-btn--xl" disabled={busy} onClick={() => void claim()}>
            Claim next move
          </button>
        </Card>
      ) : (
        <>
          <MoveLease remainingMs={remaining} />
          <MoveCompletion
            key={held.move.moveId}
            move={held.move}
            unit={held.unit}
            hostlerRef={hostlerRef}
            api={api}
            title="Your move"
            onNotice={setNotice}
            onOutcome={(o) => answered("yard-complete-move", o, { moveId: held.move.moveId }, false)}
          />
        </>
      )}
    </div>
  );
}
