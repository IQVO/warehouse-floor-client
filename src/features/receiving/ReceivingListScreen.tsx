import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card } from "@warehouse/ui-kit";
import { receivingReads, type Receipt } from "../../api/inboundReceiving";
import { describeReceivingProblem } from "../../api/receivingMessages";
import type { Message } from "../../api/problemMessages";
import { useServices } from "../../app/servicesContext";
import { normalizeScan } from "../../lib/scan";

/** /receiving: open a receipt by its id, or pick one of the open receipts. No station, no claim: receiving is not a pick task. */
export function ReceivingListScreen() {
  const { fetchFn } = useServices();
  const navigate = useNavigate();
  const [id, setId] = useState("");
  const [open, setOpen] = useState<Receipt[] | null>(null);
  const [note, setNote] = useState<Message | null>(null);

  useEffect(() => {
    let live = true;
    void receivingReads.listOpenReceipts(fetchFn()).then((r) => {
      if (!live) return;
      if (r.state === "done") setOpen(r.data.items);
      else if (r.state === "problem") setNote(describeReceivingProblem(r.problem));
      else setNote({ tone: "warning", what: "The server could not be reached, so the open receipts cannot be listed.", todo: "You can still type a receipt number." });
    });
    return () => {
      live = false;
    };
  }, [fetchFn]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = normalizeScan(id);
    if (value !== "") void navigate(`/receiving/${encodeURIComponent(value)}`);
  }

  return (
    <div className="floor-stack">
      <Card title="Receive a delivery">
        <form className="floor-form" onSubmit={submit}>
          <div className="floor-field">
            <label htmlFor="receipt-id">Receipt number</label>
            <input id="receipt-id" className="floor-input" value={id} autoComplete="off" onChange={(e) => setId(e.target.value)} />
          </div>
          <button type="submit" className="floor-btn floor-btn--primary" disabled={normalizeScan(id) === ""}>
            Open receipt
          </button>
        </form>
      </Card>
      <Card title="Open receipts">
        {note && (
          <div className={`floor-notice floor-notice--${note.tone}`} role="alert">
            <p className="floor-notice__what">{note.what}</p>
            <p className="floor-notice__todo">{note.todo}</p>
          </div>
        )}
        {open === null && note === null && <p>Loading...</p>}
        {open !== null && open.length === 0 && <p>No receipt is open right now.</p>}
        {open !== null && (
          <ul className="floor-steps">
            {open.map((r) => (
              <li key={r.receiptId}>
                <Link to={`/receiving/${encodeURIComponent(r.receiptId)}`}>{r.receiptId}</Link> &mdash; delivery notice {r.asnNumber}
                {r.doorCode ? `, door ${r.doorCode}` : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
