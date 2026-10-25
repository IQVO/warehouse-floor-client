import { barRuns, QUIET_ZONE_MODULES, type Code128Symbol } from "../lib/barcode";

/**
 * A Code 128 / GS1-128 symbol as inline SVG. The drawing is in modules (the narrowest bar is
 * 1 unit wide) and the element is sized in millimetres (`moduleMm` x modules), so a printer
 * puts down exactly that bar width; on a narrow screen `max-width: 100%` shrinks it, which is
 * fine to scan from a screen and is not what gets printed. Quiet zones are part of the drawing
 * and are painted white so the bars scan on a dark theme too.
 */
export function Barcode128({ symbol, moduleMm, heightMm = 18, title }: { symbol: Code128Symbol; moduleMm: number; heightMm?: number; title: string }) {
  const { bars, totalModules } = barRuns(symbol);
  const d = bars.map((b) => `M${b.x} 0h${b.width}v1h-${b.width}z`).join("");
  return (
    <svg
      className="floor-barcode"
      role="img"
      aria-label={title}
      data-symbology={symbol.kind}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${totalModules} 1`}
      preserveAspectRatio="none"
      width={`${round(totalModules * moduleMm)}mm`}
      height={`${heightMm}mm`}
      shapeRendering="crispEdges"
    >
      <title>{title}</title>
      <rect x="0" y="0" width={totalModules} height="1" fill="#fff" />
      <path d={d} fill="#000" />
      <desc>{`${symbol.kind}, quiet zone ${QUIET_ZONE_MODULES} modules, module ${moduleMm} mm`}</desc>
    </svg>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
