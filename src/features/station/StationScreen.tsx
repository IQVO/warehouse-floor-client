import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card } from "@warehouse/ui-kit";
import { CLAIMABLE_TASK_TYPES, type TaskType } from "../../api/fulfillmentExecution";
import { usePendingCommands } from "../../app/servicesContext";
import { ScanInput } from "../../components/ScanInput";
import { parseCapabilities } from "./parseCapabilities";
import { useStation } from "./stationState";

const TYPE_LABEL: Record<string, string> = { PICK: "Pick", RELOCATE: "Relocate", REPLENISH: "Replenish" };

export function StationScreen() {
  const { station, occupantId, held, busy, checkIn, checkOut, claimNext, register } = useStation();
  const pending = usePendingCommands();
  const navigate = useNavigate();

  if (station === null) {
    return <RegisterCard onRegister={register} busy={busy === "register"} />;
  }

  const claimPending = pending.some((e) => e.kind === "claim-next");
  const checkInPending = pending.some((e) => e.kind === "check-in");

  async function pull(type: TaskType) {
    const result = await claimNext(type);
    if (result.ok) void navigate("/task");
  }

  return (
    <div className="floor-stack">
      <Card title={`Station ${station.id}`}>
        <dl className="floor-facts">
          <dt>Capabilities</dt>
          <dd>{station.capabilities.join(", ") || "none"}</dd>
          {station.locationCode && (
            <>
              <dt>Location</dt>
              <dd className="floor-mono">{station.locationCode}</dd>
            </>
          )}
          <dt>Operator</dt>
          <dd>{station.occupied ? (occupantId ?? "checked in") : "nobody checked in"}</dd>
        </dl>
      </Card>

      {!station.occupied ? (
        <Card title="Check in">
          <ScanInput
            label="Scan your badge"
            hint="Your badge ID is attached to the work you complete here."
            disabled={busy === "check-in" || checkInPending}
            onScan={(badge) => void checkIn(badge)}
          />
          {checkInPending && <p>Check-in saved on this device; it will be sent when the connection is back.</p>}
        </Card>
      ) : (
        <>
          {held !== null ? (
            <Card title="You are holding a task">
              <p>
                {held.task.type} task <span className="floor-mono">{held.task.id}</span>
              </p>
              <Link className="floor-btn floor-btn--primary floor-btn--xl" to="/task">
                Go to the task
              </Link>
            </Card>
          ) : (
            <Card title="Pull work">
              <p>The system picks the most urgent task this station can do. Choose the kind of work.</p>
              <div className="floor-grid">
                {CLAIMABLE_TASK_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className="floor-btn floor-btn--primary floor-btn--xl"
                    disabled={busy === "claim-next" || claimPending}
                    onClick={() => void pull(type)}
                  >
                    {TYPE_LABEL[type] ?? type}
                  </button>
                ))}
              </div>
              {claimPending && <p>Your request is saved on this device; the task will appear when the connection is back.</p>}
              <p className="floor-muted">Pack, SLAM and put-wall work are not available in this version.</p>
            </Card>
          )}
          <Card title="Check out">
            <button
              type="button"
              className="floor-btn floor-btn--xl"
              disabled={held !== null || busy === "check-out"}
              onClick={() => void checkOut()}
            >
              Check out
            </button>
            {held !== null && <p className="floor-muted">Finish your task before checking out.</p>}
          </Card>
        </>
      )}

      <details className="floor-details">
        <summary>Register this station again</summary>
        <RegisterCard
          onRegister={register}
          busy={busy === "register"}
          initial={{ stationId: station.id, capabilities: station.capabilities.join(", "), locationCode: station.locationCode ?? "" }}
          bare
        />
      </details>
    </div>
  );
}

function RegisterCard({
  onRegister,
  busy,
  initial = { stationId: "", capabilities: "pick", locationCode: "" },
  bare = false,
}: {
  onRegister: (input: { stationId: string; capabilities: string[]; locationCode?: string }) => Promise<{ ok: boolean }>;
  busy: boolean;
  initial?: { stationId: string; capabilities: string; locationCode: string };
  bare?: boolean;
}) {
  const [stationId, setStationId] = useState(initial.stationId);
  const [capabilities, setCapabilities] = useState(initial.capabilities);
  const [locationCode, setLocationCode] = useState(initial.locationCode);
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const id = stationId.trim();
    const caps = parseCapabilities(capabilities);
    if (id === "") return setError("Enter the station ID.");
    if (caps.length === 0) return setError("Enter at least one capability, for example: pick");
    setError(null);
    const location = locationCode.trim();
    void onRegister({ stationId: id, capabilities: caps, ...(location === "" ? {} : { locationCode: location }) });
  }

  const form = (
    <form onSubmit={submit} className="floor-form">
      <div className="floor-field">
        <label htmlFor="floor-station-id">Station ID</label>
        <input id="floor-station-id" className="floor-input" value={stationId} onChange={(e) => setStationId(e.target.value)} autoComplete="off" />
      </div>
      <div className="floor-field">
        <label htmlFor="floor-capabilities">Capabilities (separate with commas)</label>
        <input id="floor-capabilities" className="floor-input" value={capabilities} onChange={(e) => setCapabilities(e.target.value)} autoComplete="off" />
      </div>
      <div className="floor-field">
        <label htmlFor="floor-location">Location code (optional)</label>
        <input id="floor-location" className="floor-input" value={locationCode} onChange={(e) => setLocationCode(e.target.value)} autoComplete="off" />
      </div>
      {error && (
        <p className="floor-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="floor-btn floor-btn--primary floor-btn--xl" disabled={busy}>
        {busy ? "Registering..." : "Register station"}
      </button>
    </form>
  );
  return bare ? form : <Card title="Register this station">{form}</Card>;
}
