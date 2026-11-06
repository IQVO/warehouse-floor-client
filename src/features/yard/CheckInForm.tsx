import { useState } from "react";
import { Card } from "@warehouse/ui-kit";
import type { Message } from "../../api/problemMessages";
import { LOAD_STATES, PURPOSES, TRAILER_KINDS, type CheckIn, type YardManagementApi } from "../../api/yardManagement";
import { ScanInput } from "../../components/ScanInput";
import type { Outcome } from "../../lib/commands";
import { bringsTrailers, buildCheckIn, emptyCheckIn, emptyTrailer, type CheckInDraft, type TrailerDraft } from "./checkInRules";
import { purposeText } from "./yardFormat";
import { readYardCode } from "./yardScan";
import { VisitFields } from "./VisitFields";

const KIND_TEXT: Record<string, string> = { DRY_VAN: "Dry van", REEFER: "Reefer", FLATBED: "Flatbed", CONTAINER: "Container" };
const LOAD_TEXT: Record<string, string> = { EMPTY: "Empty", LOADED: "Loaded", PARTIAL: "Part loaded" };

/** Gate clerk: check a visit in. The trailer unit numbers are scanned; the rest is typed. */
export function CheckInForm({
  siteId,
  api,
  onOutcome,
  onNotice,
}: {
  siteId: string;
  api: YardManagementApi;
  onOutcome: (outcome: Outcome<CheckIn>, reset: () => void) => void;
  onNotice: (message: Message | null) => void;
}) {
  const [draft, setDraft] = useState<CheckInDraft>(emptyCheckIn);
  const [busy, setBusy] = useState(false);

  const named = draft.appointmentId.trim() !== "";
  const takesTrailers = bringsTrailers(draft.purpose);
  const full = named && draft.trailers.length >= 1;

  const patchTrailer = (i: number, patch: Partial<TrailerDraft>) =>
    setDraft((d) => ({ ...d, trailers: d.trailers.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));

  function onScanUnit(raw: string) {
    const read = readYardCode(raw, "unit");
    if (!read.ok) {
      onNotice({ tone: "warning", what: read.message, todo: "Nothing was added." });
      return;
    }
    onNotice(null);
    setDraft((d) => (d.trailers.some((t) => t.unitNumber.toLowerCase() === read.code.toLowerCase()) ? d : { ...d, trailers: [...d.trailers, emptyTrailer(read.code)] }));
  }

  async function submit() {
    const built = buildCheckIn(siteId, draft);
    if (!built.ok) {
      onNotice({ tone: "warning", what: built.message, todo: "Nothing was sent." });
      return;
    }
    setBusy(true);
    try {
      onOutcome(await api.checkInVisit(built.body), () => setDraft(emptyCheckIn));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Check a truck in">
      <form
        className="floor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <VisitFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        <div className="floor-field">
          <label htmlFor="yard-purpose">Purpose</label>
          <select id="yard-purpose" className="floor-input" value={draft.purpose} onChange={(e) => setDraft((d) => ({ ...d, purpose: e.target.value as CheckInDraft["purpose"] }))}>
            <option value="">Choose...</option>
            {PURPOSES.map((p) => (
              <option key={p} value={p}>
                {purposeText(p)}
              </option>
            ))}
          </select>
        </div>

        {takesTrailers ? (
          <>
            <p className="floor-muted">{named ? "An appointment covers exactly one trailer." : "List every trailer the truck brings."}</p>
            <ScanInput label="Scan the trailer unit number" hint="Painted number on the trailer" onScan={onScanUnit} disabled={busy || full} />
            {draft.trailers.map((t, i) => (
              <fieldset key={t.unitNumber} className="floor-field">
                <legend>Trailer {i + 1}: {t.unitNumber}</legend>
                <label htmlFor={`kind-${i}`}>Kind of trailer {i + 1}</label>
                <select id={`kind-${i}`} className="floor-input" value={t.kind} onChange={(e) => patchTrailer(i, { kind: e.target.value as TrailerDraft["kind"] })}>
                  <option value="">Choose...</option>
                  {TRAILER_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_TEXT[k]}
                    </option>
                  ))}
                </select>
                <label htmlFor={`load-${i}`}>Load state {i + 1}</label>
                <select id={`load-${i}`} className="floor-input" value={t.loadState} onChange={(e) => patchTrailer(i, { loadState: e.target.value as TrailerDraft["loadState"] })}>
                  <option value="">Choose...</option>
                  {LOAD_STATES.map((l) => (
                    <option key={l} value={l}>
                      {LOAD_TEXT[l]}
                    </option>
                  ))}
                </select>
                <label htmlFor={`seal-${i}`}>Seal number {i + 1} (optional)</label>
                <input id={`seal-${i}`} className="floor-input" value={t.sealNumber} autoComplete="off" onChange={(e) => patchTrailer(i, { sealNumber: e.target.value })} />
                <button type="button" className="floor-btn floor-btn--quiet" onClick={() => setDraft((d) => ({ ...d, trailers: d.trailers.filter((_, j) => j !== i) }))}>
                  Remove trailer {i + 1}
                </button>
              </fieldset>
            ))}
          </>
        ) : (
          draft.purpose !== "" && <p className="floor-muted">This purpose brings no trailer to list.</p>
        )}

        <button type="submit" className="floor-btn floor-btn--primary floor-btn--xl" disabled={busy}>
          Check in this truck
        </button>
      </form>
    </Card>
  );
}
