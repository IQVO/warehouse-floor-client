import type { CartonLabel } from "../../api/inboundReceiving";
import { Barcode128 } from "../../components/Barcode128";
import { labelBarcodeFor } from "../../lib/barcode";

/**
 * The label DATA the service returned (it has no printer driver), laid out for
 * the browser's print dialog. Print CSS (floor.css) hides everything else on
 * the page, so the sheet that comes out is the label alone.
 *
 * The barcode is drawn here from the carton's license plate: GS1-128 for an SSCC,
 * Code 128 (set B) for an internal `LPN-<ulid>`, so the next scan (stow) can read it.
 * When the plate is neither, no barcode is drawn and the operator is told, because
 * a label that looks scannable and is not is worse than none.
 */
export function LabelCard({ label }: { label: CartonLabel }) {
  const barcode = labelBarcodeFor(label.lpn);
  return (
    <section className="floor-label" aria-label={`Label ${label.lpn}`}>
      {barcode !== null ? (
        <div className="floor-label__barcode">
          <Barcode128 symbol={barcode.symbol} moduleMm={barcode.moduleMm} title={`Barcode ${barcode.humanReadable}`} />
        </div>
      ) : (
        <p className="floor-label__nobarcode" role="alert">
          This label has no barcode: the carton number is not one the scanner can read. Do not stick it; tell your lead.
        </p>
      )}
      <p className="floor-label__text floor-mono">{barcode !== null ? barcode.humanReadable : label.humanReadable}</p>
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
