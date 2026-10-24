import type { CartonLabel } from "../../api/inboundReceiving";

/**
 * The label DATA the service returned (it has no printer driver), laid out for
 * the browser's print dialog. Print CSS (floor.css) hides everything else on
 * the page, so the sheet that comes out is the label alone.
 *
 * The barcode itself (CODE128) is not drawn yet: the text under it is what
 * the label carries, see docs/station-flow.md.
 */
export function LabelCard({ label }: { label: CartonLabel }) {
  return (
    <section className="floor-label" aria-label={`Label ${label.lpn}`}>
      <p className="floor-label__text floor-mono">{label.humanReadable}</p>
      <dl className="floor-facts">
        {label.sku !== undefined && (
          <>
            <dt>SKU</dt>
            <dd>{label.sku}</dd>
          </>
        )}
        <dt>Units</dt>
        <dd>{label.units}</dd>
        <dt>Received</dt>
        <dd>{label.receivedAt}</dd>
      </dl>
      <button type="button" className="floor-btn floor-btn--primary floor-label__print" onClick={() => window.print()}>
        Print label
      </button>
    </section>
  );
}
