import { useId } from "react";

interface Fields {
  carrier: string;
  carrierScac: string;
  tractorPlate: string;
  appointmentId: string;
}

/** The fields a check-in and a rejection share: who is at the gate, and which appointment (if any) they name. */
export function VisitFields<T extends Fields>({ draft, onChange }: { draft: T; onChange: (patch: Partial<Fields>) => void }) {
  const id = useId();
  const field = (key: keyof Fields, label: string, hint?: string) => (
    <div className="floor-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input id={`${id}-${key}`} className="floor-input" value={draft[key]} autoComplete="off" onChange={(e) => onChange({ [key]: e.target.value })} />
      {hint && <span className="floor-muted">{hint}</span>}
    </div>
  );
  return (
    <>
      {field("carrier", "Carrier")}
      {field("carrierScac", "Carrier code (optional)", "2 to 4 capital letters")}
      {field("tractorPlate", "Tractor plate")}
      {field("appointmentId", "Appointment id (optional)")}
    </>
  );
}
