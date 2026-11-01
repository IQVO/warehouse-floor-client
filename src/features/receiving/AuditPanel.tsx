import type { AuditLine } from "./scanToRequest";

export function AuditPanel({ lines, onChange }: { lines: AuditLine[]; onChange: (l: AuditLine[]) => void }) {
  return (
    <details className="floor-details" open={lines.length > 0}>
      <summary>Mixed carton: count what is inside</summary>
      <p className="floor-muted">
        Optional. Enter what you counted for each SKU, then scan the carton label. The counted quantities are what is received, not the label&apos;s.
      </p>
      {lines.map((l, i) => (
        <div className="floor-scan__row" key={i}>
          <input
            className="floor-input"
            aria-label={`Counted SKU ${i + 1}`}
            placeholder="SKU"
            value={l.sku}
            onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))}
          />
          <input
            className="floor-input"
            aria-label={`Counted quantity ${i + 1}`}
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="Qty"
            value={l.qty}
            onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
          />
          <button type="button" className="floor-btn floor-btn--quiet" onClick={() => onChange(lines.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="floor-btn" onClick={() => onChange([...lines, { sku: "", qty: "" }])}>
        Add a SKU
      </button>
    </details>
  );
}
