import { useState } from "react";
import { Card } from "@warehouse/ui-kit";
import type { Message } from "../../api/problemMessages";
import { LOAD_STATES, PURPOSES, SEAL_CLASSES, TRAILER_KINDS, type CheckIn, type YardManagementApi } from "../../api/yardManagement";
import { ScanInput } from "../../components/ScanInput";
import type { Outcome } from "../../lib/commands";
import { bringsTrailers, buildCheckIn, emptyTrailer, type CheckInDraft, type TrailerDraft } from "./checkInRules";
import { purposeText, SEAL_CLASS_TEXT } from "./yardFormat";
import { readYardCode } from "./yardScan";
import { VisitFields } from "./VisitFields";

const KIND_TEXT: Record<string, string> = { DRY_VAN: "Dry van", REEFER: "Reefer", FLATBED: "Flatbed", CONTAINER: "Container" };
const LOAD_TEXT: Record<string, string> = { EMPTY: "Empty", LOADED: "Loaded", PARTIAL: "Part loaded" };

/**
 * Gate clerk: check a visit in. The trailer unit numbers are scanned; the rest is typed.
 * The gate screen holds what is typed (`draft`): it is the one that knows when a truck is finished.
 */
export function CheckInForm({
  siteId,
  api,
  draft,
  onDraft: setDraft,
  onOutcome,
  onNotice,
}: {
  siteId: string;
  api: YardManagementApi;
  draft: CheckInDraft;
  onDraft: (update: (draft: CheckInDraft) => CheckInDraft) => void;
  /** `tractorPlate` is the plate as it was sent, so the screen can name the truck the answer is about. */
  onOutcome: (outcome: Outcome<CheckIn>, tractorPlate: string) => void;
  onNotice: (message: Message | null) => void;
}) {
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
      onOutcome(await api.checkInVisit(built.body), built.body.tractorPlate);
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
                <input
                  id={`seal-${i}`}
                  className="floor-input"
                  value={t.sealNumber}
                  autoComplete="off"
                  // No seal, no strength: a choice made for a seal that was then removed must not come back by itself.
                  onChange={(e) => patchTrailer(i, e.target.value.trim() === "" ? { sealNumber: e.target.value, sealClass: "" } : { sealNumber: e.target.value })}
                />
                {t.sealNumber.trim() !== "" && (
                  <>
                    <label htmlFor={`seal-class-${i}`}>Seal strength {i + 1} (optional)</label>
                    <select id={`seal-class-${i}`} className="floor-input" value={t.sealClass} aria-describedby={`seal-class-hint-${i}`} onChange={(e) => patchTrailer(i, { sealClass: e.target.value as TrailerDraft["sealClass"] })}>
                      <option value="">Not stated</option>
                      {SEAL_CLASSES.map((c) => (
                        <option key={c} value={c}>
                          {SEAL_CLASS_TEXT[c]}
                        </option>
                      ))}
                    </select>
                    <span id={`seal-class-hint-${i}`} className="floor-muted">
                      The letter marked on the seal or written on the paperwork: I, S or H. Some sites only take stronger seals. If you cannot tell, leave it not stated.
                    </span>
                  </>
                )}
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
