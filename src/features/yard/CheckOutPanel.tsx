import { useEffect, useMemo, useState } from "react";
import { Card } from "@warehouse/ui-kit";
import type { Message } from "../../api/problemMessages";
import { describeYardReadFailure } from "../../api/yardMessages";
import { yardReads, type Trailer, type Visit, type YardManagementApi } from "../../api/yardManagement";
import { useServices } from "../../app/servicesContext";
import { ScanInput } from "../../components/ScanInput";
import type { Outcome } from "../../lib/commands";
import { placeText, purposeText, releaseBlocker } from "./yardFormat";
import { readYardCode } from "./yardScan";

/** Gate clerk: check a visit out, naming the trailers that leave with the tractor (none for a drop or a bobtail). */
export function CheckOutPanel({
  siteId,
  api,
  onOutcome,
  onNotice,
}: {
  siteId: string;
  api: YardManagementApi;
  onOutcome: (outcome: Outcome<Visit>) => void;
  onNotice: (message: Message | null) => void;
}) {
  const { fetchFn } = useServices();
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [plate, setPlate] = useState("");
  const [chosen, setChosen] = useState<Visit | null>(null);
  const [out, setOut] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // The parent remounts this panel (key) when the site or the yard state changed, which reloads the list.
  useEffect(() => {
    if (siteId === "") return;
    let live = true;
    void Promise.all([yardReads.listVisits({ siteId, state: "CHECKED_IN" }, fetchFn()), yardReads.listTrailers({ siteId }, fetchFn())]).then(([v, t]) => {
      if (!live) return;
      if (v.state !== "done") onNotice(describeYardReadFailure(v, "the visits"));
      else setVisits(v.data);
      if (t.state === "done") setTrailers(t.data);
      else if (v.state === "done") onNotice(describeYardReadFailure(t, "the trailers"));
    });
    return () => {
      live = false;
    };
  }, [siteId, fetchFn, onNotice]);

  // The trailers that may leave with this visit: the ones it brought, and for a pickup the ones parked on site.
  const candidates = useMemo(() => {
    if (chosen === null) return [];
    return trailers.filter((t) => t.visitId === chosen.visitId || (chosen.purpose === "PICKUP" && t.state === "PARKED"));
  }, [chosen, trailers]);

  function choose(v: Visit) {
    setChosen(v);
    // A live visit leaves with its trailer if it is ready; a drop leaves it behind.
    const live = v.purpose === "LIVE_UNLOAD" || v.purpose === "LIVE_LOAD";
    setOut(new Set(live ? trailers.filter((t) => t.visitId === v.visitId && releaseBlocker(t) === null).map((t) => t.trailerId) : []));
  }

  function onScanUnit(raw: string) {
    const read = readYardCode(raw, "unit");
    const match = read.ok ? candidates.find((t) => t.unitNumber.toLowerCase() === read.code.toLowerCase()) : undefined;
    if (!read.ok || match === undefined) {
      onNotice({ tone: "warning", what: read.ok ? `${read.code} is not one of this visit's trailers.` : read.message, todo: "Scan the unit number of a trailer in the list." });
      return;
    }
    onNotice(null);
    setOut((s) => new Set(s).add(match.trailerId));
  }

  async function checkOut() {
    if (chosen === null) return;
    setBusy(true);
    try {
      onOutcome(await api.checkOutVisit(chosen.visitId, [...out]));
    } finally {
      setBusy(false);
    }
  }

  const shown = (visits ?? []).filter((v) => plate.trim() === "" || v.tractorPlate.toLowerCase().includes(plate.trim().toLowerCase()));

  return (
    <Card title="Check a truck out">
      {chosen === null ? (
        <div className="floor-form">
          <div className="floor-field">
            <label htmlFor="yard-out-plate">Tractor plate</label>
            <input id="yard-out-plate" className="floor-input" value={plate} autoComplete="off" onChange={(e) => setPlate(e.target.value)} />
          </div>
          {visits === null && siteId !== "" && <p>Loading the trucks on site...</p>}
          {siteId === "" && <p>Enter the site code first.</p>}
          {visits !== null && shown.length === 0 && <p>No truck is checked in{plate.trim() === "" ? "" : " with that plate"}.</p>}
          <ul className="floor-steps">
            {shown.map((v) => (
              <li key={v.visitId}>
                <button type="button" className="floor-btn" onClick={() => choose(v)}>
                  {v.tractorPlate}
                </button>{" "}
                {v.carrier} &mdash; {purposeText(v.purpose)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="floor-form">
          <dl className="floor-facts">
            <dt>Truck</dt>
            <dd>{chosen.tractorPlate}</dd>
            <dt>Carrier</dt>
            <dd>{chosen.carrier}</dd>
            <dt>Purpose</dt>
            <dd>{purposeText(chosen.purpose)}</dd>
          </dl>
          {candidates.length === 0 ? <p>No trailer to take out. The truck leaves on its own.</p> : <p>Tick the trailers that leave with the truck. A trailer left unticked stays in the yard.</p>}
          {chosen.purpose === "PICKUP" && <ScanInput label="Scan the unit number of the trailer being picked up" onScan={onScanUnit} disabled={busy} />}
          <ul className="floor-steps">
            {candidates.map((t) => {
              const blocker = releaseBlocker(t);
              return (
                <li key={t.trailerId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={out.has(t.trailerId)}
                      onChange={(e) =>
                        setOut((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(t.trailerId);
                          else next.delete(t.trailerId);
                          return next;
                        })
                      }
                    />{" "}
                    Take out {t.unitNumber}
                  </label>{" "}
                  <span className="floor-muted">
                    ({placeText(t.location)}
                    {blocker === null ? ", ready to leave" : `, not ready: ${blocker}`})
                  </span>
                </li>
              );
            })}
          </ul>
          <button type="button" className="floor-btn floor-btn--primary floor-btn--xl" disabled={busy} onClick={() => void checkOut()}>
            Check out this truck
          </button>
          <button type="button" className="floor-btn floor-btn--quiet" disabled={busy} onClick={() => setChosen(null)}>
            Pick another truck
          </button>
        </div>
      )}
    </Card>
  );
}
