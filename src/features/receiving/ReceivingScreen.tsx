import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Card, StatusPill } from "@warehouse/ui-kit";
import {
  inboundReceivingApi,
  receivingReads,
  type CartonLabel,
  type Receipt,
  type ScanResult,
} from "../../api/inboundReceiving";
import { describeReceivingProblem } from "../../api/receivingMessages";
import { describeQueued, type Message } from "../../api/problemMessages";
import { usePendingCommands, useServices } from "../../app/servicesContext";
import { ScanInput } from "../../components/ScanInput";
import type { Outcome } from "../../lib/commands";
import { newIdempotencyKey } from "../../lib/idempotency";
import { buildScanRequest, type AuditLine, type Mode } from "./scanToRequest";
import { AuditPanel } from "./AuditPanel";
import { Banner } from "./Banner";
import { LastScan } from "./LastScan";
import { MODES } from "./receivingModes";

export function ReceivingScreen() {
  const { receiptId = "" } = useParams();
  const { runner, fetchFn } = useServices();
  const api = useMemo(() => inboundReceivingApi(runner), [runner]);
  const pending = usePendingCommands().filter((e) => e.kind === "receive-scan" && e.meta.receiptId === receiptId).length;

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loadNote, setLoadNote] = useState<Message | null>(null);
  const [last, setLast] = useState<ScanResult | null>(null);
  const [notice, setNotice] = useState<Message | null>(null);
  const [mode, setMode] = useState<Mode>("carton");
  const [count, setCount] = useState("1");
  const [audit, setAudit] = useState<AuditLine[]>([]);
  const [labels, setLabels] = useState<Record<string, CartonLabel>>({});
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const labelFetched = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    void receivingReads.getReceipt(receiptId, fetchFn()).then((r) => {
      if (!live) return;
      if (r.state === "done") {
        setReceipt(r.data);
        setLoadNote(null);
      } else if (r.state === "problem") {
        setLoadNote(describeReceivingProblem(r.problem));
      } else {
        setLoadNote({
          tone: "warning",
          what: "The server could not be reached, so the receipt cannot be shown.",
          todo: "Check the connection and reload the page.",
        });
      }
    });
    return () => {
      live = false;
    };
  }, [receiptId, fetchFn]);

  const showResult = useCallback(
    (result: ScanResult) => {
      setLast(result);
      setReceipt((r) => (r === null ? r : { ...r, lines: result.lines, version: result.version }));
      // An unlabelled carton gets an internal LPN: fetch its label data so it can be printed.
      if (result.discrepancies.some((d) => d.kind === "UnlabelledCarton")) {
        for (const c of result.cartons) {
          if (c.sscc !== undefined || labelFetched.current.has(c.lpn)) continue;
          labelFetched.current.add(c.lpn);
          void receivingReads.getCartonLabel(receiptId, c.lpn, fetchFn()).then((l) => {
            if (l.state === "done") setLabels((m) => ({ ...m, [c.lpn]: l.data }));
            else labelFetched.current.delete(c.lpn);
          });
        }
      }
    },
    [receiptId, fetchFn],
  );

  const handleOutcome = useCallback(
    (o: Outcome, what: string) => {
      switch (o.state) {
        case "done": {
          if (what === "close") {
            setReceipt(o.data as Receipt);
            setNotice({ tone: "success", what: "The receipt is closed.", todo: "Short and over lines are listed below." });
            return;
          }
          const result = o.data as ScanResult | undefined;
          if (result === undefined) return;
          showResult(result);
          setNotice(
            result.accepted
              ? { tone: "success", what: "Received.", todo: "Scan the next one." }
              : { tone: "warning", what: "Not received. Nothing was booked for that scan.", todo: "See what to do below." },
          );
          return;
        }
        case "problem":
          setNotice(describeReceivingProblem(o.problem));
          return;
        case "queued":
          setNotice(describeQueued(what === "close" ? "close request" : "scan", o.reason));
          return;
        case "unsent":
          return;
      }
    },
    [showResult],
  );

  // A scan saved offline (or before a reload) is answered later by a replay: show that answer too.
  useEffect(
    () =>
      runner.onSettled((entry, outcome) => {
        if (entry.meta.receiptId !== receiptId) return;
        if (entry.kind === "receive-scan") handleOutcome(outcome, "scan");
        else if (entry.kind === "close-receipt") handleOutcome(outcome, "close");
      }),
    [runner, receiptId, handleOutcome],
  );

  async function onScan(raw: string) {
    const built = buildScanRequest(raw, mode, Number(count), audit);
    if (!built.ok) {
      setNotice({ tone: "warning", what: built.message, todo: "Nothing was sent." });
      return;
    }
    setBusy(true);
    try {
      // Each physical scan is its own action with its own key (a repeat of the same code counts again).
      handleOutcome(await api.receiveScan(receiptId, newIdempotencyKey(), built.request), "scan");
      setCount("1");
      setAudit([]);
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    setConfirmClose(false);
    setBusy(true);
    try {
      handleOutcome(await api.closeReceipt(receiptId), "close");
    } finally {
      setBusy(false);
    }
  }

  const closed = receipt?.state === "Closed";
  const activeMode = MODES.find((m) => m.id === mode) ?? MODES[0];

  return (
    <div className="floor-stack">
      <Card title={`Receipt ${receiptId}`}>
        {receipt === null ? (
          loadNote === null ? (
            <p>Loading the receipt...</p>
          ) : (
            <Banner message={loadNote} />
          )
        ) : (
          <>
            <dl className="floor-facts">
              <dt>Delivery notice</dt>
              <dd>{receipt.asnNumber}</dd>
              {receipt.doorCode && (
                <>
                  <dt>Door</dt>
                  <dd>{receipt.doorCode}</dd>
                </>
              )}
              <dt>State</dt>
              <dd>
                <StatusPill status={receipt.state} />
              </dd>
            </dl>
            {loadNote && <Banner message={loadNote} />}
          </>
        )}
        <Link className="floor-btn floor-btn--quiet" to="/receiving">
          Other receipts
        </Link>
      </Card>

      {notice && (
        <div className={`floor-notice floor-notice--${notice.tone}`} role={notice.tone === "success" || notice.tone === "info" ? "status" : "alert"}>
          <p className="floor-notice__what">{notice.what}</p>
          <p className="floor-notice__todo">{notice.todo}</p>
          <button type="button" className="floor-btn floor-btn--quiet" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {receipt !== null && !closed && (
        <Card title="Scan to receive">
          <fieldset className="floor-modes" aria-label="What are you scanning">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`floor-btn${mode === m.id ? " floor-btn--primary" : ""}`}
                aria-pressed={mode === m.id}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </fieldset>

          {mode !== "carton" && (
            <div className="floor-field">
              <label htmlFor="recv-count">{mode === "case" ? "Cases in this scan" : "Items in this scan"}</label>
              <input
                id="recv-count"
                className="floor-input"
                type="number"
                inputMode="numeric"
                min={1}
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </div>
          )}

          {mode === "carton" && <AuditPanel lines={audit} onChange={setAudit} />}

          <ScanInput label="Scan now" hint={activeMode?.hint} onScan={(v) => void onScan(v)} disabled={busy} />
          {pending > 0 && (
            <p className="floor-muted">
              {pending} {pending === 1 ? "scan is" : "scans are"} saved on this device and will be sent when the connection is back.
            </p>
          )}
        </Card>
      )}

      {last !== null && <LastScan result={last} labels={labels} />}

      {receipt !== null && (
        <Card title="Received so far (eaches)">
          <table className="floor-table">
            <thead>
              <tr>
                <th>Line</th>
                <th>SKU</th>
                <th>Expected</th>
                <th>Good</th>
                <th>Damaged</th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td>{l.lineNo}</td>
                  <td>{l.sku}</td>
                  <td>{l.expectedQty}</td>
                  <td>{l.receivedGood}</td>
                  <td>{l.receivedDamaged}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {closed && receipt.discrepancies.length > 0 && (
            <ul className="floor-steps">
              {receipt.discrepancies.map((d) => (
                <li key={`${d.lineNo}-${d.kind}`}>
                  {d.sku}: {d.kind} (expected {d.expectedQty}, received {d.receivedQty}, damaged {d.damagedQty})
                </li>
              ))}
            </ul>
          )}
          {!closed &&
            (confirmClose ? (
              <div className="floor-scan__row">
                <button type="button" className="floor-btn floor-btn--primary" disabled={busy} onClick={() => void close()}>
                  Yes, close the receipt
                </button>
                <button type="button" className="floor-btn floor-btn--quiet" onClick={() => setConfirmClose(false)}>
                  Keep receiving
                </button>
              </div>
            ) : (
              <button type="button" className="floor-btn" disabled={busy} onClick={() => setConfirmClose(true)}>
                Close receipt
              </button>
            ))}
        </Card>
      )}
    </div>
  );
}
