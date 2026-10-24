import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { describeProblem, describeQueued, describeUnsent, type Message } from "../../api/problemMessages";
import { fulfillmentApi, type PickScanResult, type Station, type Task } from "../../api/fulfillmentExecution";
import { useServices } from "../../app/servicesContext";
import type { Outcome } from "../../lib/commands";
import type { OutboxEntry } from "../../lib/outbox";
import { log } from "../../lib/log";
import { problemCode } from "../../lib/problem";
import {
  leaseDurationFromClaim,
  loadPersisted,
  RENEW_AT_FRACTION,
  RENEW_RETRY_MS,
  STORAGE_KEY,
  StationContext,
  type ActionResult,
  type HeldTask,
  type Notice,
  type Persisted,
  type StationApi,
} from "./stationState";

export function StationProvider({ children }: { children: ReactNode }) {
  const { store, runner, now: clock } = useServices();
  const api = useMemo(() => fulfillmentApi(runner), [runner]);

  const [state, setState] = useState<Persisted>(() => loadPersisted(store.getItem(STORAGE_KEY)));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [now, setNow] = useState(() => clock());
  const [renewFailing, setRenewFailing] = useState(false);
  const [lastScan, setLastScan] = useState<StationApi["lastScan"]>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const noticeSeq = useRef(0);
  const renewing = useRef(false);
  const scanSeq = useRef(0);
  const lastRenewTry = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    store.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [store, state]);

  const say = useCallback((message: Message) => {
    noticeSeq.current += 1;
    setNotice({ ...message, id: noticeSeq.current });
  }, []);

  // ---- applying an outcome: shared by a direct submit and by an outbox replay ----
  const apply = useCallback(
    (kind: string, meta: Record<string, string>, outcome: Outcome, replayed: boolean): ActionResult => {
      if (outcome.state === "queued") {
        say(describeQueued(labelFor(kind), outcome.reason));
        return { ok: false, queued: true };
      }
      if (outcome.state === "unsent") {
        say(describeUnsent(labelFor(kind), outcome.reason));
        return { ok: false, queued: false };
      }

      if (outcome.state === "problem") {
        const code = problemCode(outcome.problem);
        log.warn("command rejected", kind, outcome.status, code);
        if ((kind === "complete" || kind === "break-case") && code === "task-already-completed") {
          // Either someone finished it, or our earlier attempt went through and its
          // answer was lost. Either way the operator's work is done: move on.
          setState((s) => (s.held?.task.id === meta.taskId ? { ...s, held: null } : s));
          say({ tone: "info", what: "This task was already completed.", todo: "Pull the next task." });
          return { ok: true, queued: false };
        }
        if (
          (kind === "complete" || kind === "renew-lease" || kind === "pick-scan" || kind === "break-case") &&
          ["task-not-claimed", "task-not-owner", "task-not-found"].includes(code)
        ) {
          // The claim is gone: holding on to the task would only invite more errors.
          setState((s) => (s.held?.task.id === meta.taskId ? { ...s, held: null } : s));
        }
        if (kind === "check-out" && code === "station-not-occupied") {
          setState((s) => ({ ...s, station: s.station ? { ...s.station, occupied: false } : null, occupantId: null }));
        }
        say(describeProblem(outcome.problem));
        return { ok: false, queued: false };
      }

      // done
      switch (kind) {
        case "register": {
          const station = outcome.data as Station;
          setState((s) => ({ ...s, station, held: s.station?.id === station.id ? s.held : null }));
          say({ tone: "success", what: `Station ${station.id} is registered.`, todo: "Check in to start working." });
          break;
        }
        case "check-in": {
          const station = outcome.data as Station;
          setState((s) => ({ ...s, station, occupantId: meta.occupantId ?? s.occupantId }));
          say({ tone: "success", what: `Checked in${meta.occupantId ? ` as ${meta.occupantId}` : ""}.`, todo: "Pull a task when you are ready." });
          break;
        }
        case "check-out": {
          const station = outcome.data as Station;
          setState((s) => ({ ...s, station, occupantId: null }));
          say({ tone: "success", what: "Checked out.", todo: "Thank you." });
          break;
        }
        case "claim-next": {
          const task = outcome.data as Task;
          const durationMs = leaseDurationFromClaim(task, outcome.serverTime, clock());
          const held: HeldTask = { task, leaseDurationMs: durationMs, leaseExpiresAt: clock() + durationMs };
          if (stateRef.current.held !== null && replayed) {
            // A claim that was replayed after reconnect landed while the operator already
            // holds another task. Keep the one in hand; the extra lease lapses back to the pool.
            log.warn("extra claim after replay left to expire", task.id);
            say({ tone: "warning", what: "An extra task was claimed when the connection came back.", todo: "Ignore it: it returns to the pool by itself. Carry on with your current task." });
          } else {
            setState((s) => ({ ...s, held }));
            setNow(clock());
            setRenewFailing(false);
            say({ tone: "success", what: `Task ${task.id} is yours.`, todo: "Scan to confirm, then complete it." });
          }
          break;
        }
        case "complete": {
          setState((s) => (s.held?.task.id === meta.taskId ? { ...s, held: null } : s));
          say({ tone: "success", what: `Task ${meta.taskId ?? "(unknown)"} completed.`, todo: "Pull the next task." });
          break;
        }
        case "pick-scan": {
          const r = outcome.data as PickScanResult | undefined;
          if (r === undefined) break;
          setLastScan({ taskId: meta.taskId ?? "", result: r });
          const left = r.plannedEaches - r.pickedEaches;
          say({
            tone: "success",
            what: `Counted ${r.addedEaches} ${r.addedEaches === 1 ? "each" : "eaches"} (${r.level === "CASE" ? "case" : "item"} scan). ${r.pickedEaches} of ${r.plannedEaches} picked.`,
            todo: left > 0 ? "Scan the next one." : "The pick is complete. Scan the order label, then complete the task.",
          });
          return { ok: true, queued: false, data: r };
        }
        case "break-case": {
          setState((s) => (s.held?.task.id === meta.taskId ? { ...s, held: null } : s));
          say({ tone: "success", what: `Case broken. Task ${meta.taskId ?? "(unknown)"} completed.`, todo: "Pull the next task." });
          break;
        }
        default:
          break;
      }
      return { ok: true, queued: false };
    },
    [say, clock],
  );

  // Commands that were saved while offline settle here, minutes or a reload later.
  useEffect(() => {
    return runner.onSettled((entry: OutboxEntry, outcome) => {
      apply(entry.kind, entry.meta, outcome, true);
    });
  }, [runner, apply]);

  const run = useCallback(
    async (kind: string, send: () => Promise<Outcome>, meta: Record<string, string>): Promise<ActionResult> => {
      setBusy(kind);
      try {
        return apply(kind, meta, await send(), false);
      } finally {
        setBusy(null);
      }
    },
    [apply],
  );

  // ---- lease countdown + renewal timer ----
  const heldId = state.held?.task.id ?? null;
  useEffect(() => {
    if (heldId === null) return;
    const timer = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(timer);
  }, [heldId, clock]);

  useEffect(() => {
    const held = state.held;
    const station = state.station;
    if (held === null || station === null) return;
    const remaining = held.leaseExpiresAt - now;
    if (remaining <= 0 || remaining > held.leaseDurationMs * RENEW_AT_FRACTION) return;
    if (renewing.current || now - lastRenewTry.current < RENEW_RETRY_MS) return;
    renewing.current = true;
    lastRenewTry.current = now;
    const taskId = held.task.id;
    void api
      .renewLease(taskId, station.id)
      .then((outcome) => {
        if (outcome.state === "done") {
          setRenewFailing(false);
          setNow(clock());
          setState((s) =>
            s.held?.task.id === taskId ? { ...s, held: { ...s.held, leaseExpiresAt: clock() + s.held.leaseDurationMs } } : s,
          );
        } else if (outcome.state === "problem") {
          setRenewFailing(false);
          apply("renew-lease", { taskId }, outcome, false);
        } else {
          setRenewFailing(true);
        }
      })
      .finally(() => {
        renewing.current = false;
      });
  }, [now, state.held, state.station, api, apply, clock]);

  const value = useMemo<StationApi>(
    () => ({
      station: state.station,
      occupantId: state.occupantId,
      held: state.held,
      now,
      busy,
      notice,
      lastScan,
      renewFailing: renewFailing && heldId !== null,
      dismissNotice: () => setNotice(null),
      register: (input) => run("register", () => api.registerStation(input), { stationId: input.stationId }),
      checkIn: (occupantId) => {
        const id = stateRef.current.station?.id;
        if (id === undefined) return Promise.resolve({ ok: false, queued: false });
        return run("check-in", () => api.checkIn(id, occupantId), { stationId: id, occupantId });
      },
      checkOut: () => {
        const id = stateRef.current.station?.id;
        if (id === undefined) return Promise.resolve({ ok: false, queued: false });
        return run("check-out", () => api.checkOut(id), { stationId: id });
      },
      claimNext: (taskType) => {
        const id = stateRef.current.station?.id;
        if (id === undefined) return Promise.resolve({ ok: false, queued: false });
        return run("claim-next", () => api.claimNext(id, taskType), { stationId: id, taskType });
      },
      completeTask: (confirmation) => {
        const { station, held } = stateRef.current;
        if (station === null || held === null) return Promise.resolve({ ok: false, queued: false });
        const taskId = held.task.id;
        return run("complete", () => api.completeTask(taskId, station.id, confirmation), { taskId, stationId: station.id });
      },
      scanPick: (gtin) => {
        const { station, held } = stateRef.current;
        if (station === null || held === null) return Promise.resolve({ ok: false, queued: false });
        const taskId = held.task.id;
        scanSeq.current += 1;
        const scanId = `${Date.now().toString(36)}-${scanSeq.current}`;
        return run("pick-scan", () => api.confirmPickScan(taskId, station.id, gtin, scanId), { taskId, stationId: station.id, gtin });
      },
      breakCase: () => {
        const { station, held } = stateRef.current;
        if (station === null || held === null) return Promise.resolve({ ok: false, queued: false });
        const taskId = held.task.id;
        return run("break-case", () => api.breakCase(taskId, station.id), { taskId, stationId: station.id });
      },
      retryNow: () => void runner.flush(),
    }),
    [state, now, busy, notice, renewFailing, lastScan, heldId, api, run, runner],
  );

  return <StationContext value={value}>{children}</StationContext>;
}

function labelFor(kind: string): string {
  switch (kind) {
    case "register":
      return "station registration";
    case "check-in":
      return "check-in";
    case "check-out":
      return "check-out";
    case "claim-next":
      return "request for the next task";
    case "complete":
      return "completion";
    case "pick-scan":
      return "scan";
    case "break-case":
      return "case break";
    default:
      return "action";
  }
}
