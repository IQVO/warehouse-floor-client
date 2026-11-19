import { useState } from "react";
import { Card } from "@warehouse/ui-kit";
import type { Message } from "../../api/problemMessages";
import { REJECTION_REASONS, type Visit, type YardManagementApi } from "../../api/yardManagement";
import type { Outcome } from "../../lib/commands";
import { buildReject, emptyReject, type RejectDraft } from "./checkInRules";
import { REJECTION_TEXT } from "./yardFormat";
import { VisitFields } from "./VisitFields";

/** Gate clerk: turn a truck away. Records a REJECTED visit; the appointment (if named) is cancelled downstream. */
export function RejectForm({
  siteId,
  api,
  onOutcome,
  onNotice,
}: {
  siteId: string;
  api: YardManagementApi;
  onOutcome: (outcome: Outcome<Visit>, reset: () => void) => void;
  onNotice: (message: Message | null) => void;
}) {
  const [draft, setDraft] = useState<RejectDraft>(emptyReject);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const built = buildReject(siteId, draft);
    if (!built.ok) {
      onNotice({ tone: "warning", what: built.message, todo: "Nothing was sent." });
      return;
    }
    setBusy(true);
    try {
      onOutcome(await api.rejectAtGate(built.body), () => setDraft(emptyReject));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Turn a truck away">
      <form
        className="floor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <VisitFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        <div className="floor-field">
          <label htmlFor="yard-reject-reason">Reason</label>
          <select id="yard-reject-reason" className="floor-input" value={draft.reason} onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value as RejectDraft["reason"] }))}>
            <option value="">Choose...</option>
            {REJECTION_REASONS.map((r) => (
              <option key={r} value={r}>
                {REJECTION_TEXT[r]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="floor-btn floor-btn--primary floor-btn--xl" disabled={busy}>
          Reject at the gate
        </button>
      </form>
    </Card>
  );
}
