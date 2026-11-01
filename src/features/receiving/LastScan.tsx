import { Card } from "@warehouse/ui-kit";
import type { CartonLabel, ScanResult } from "../../api/inboundReceiving";
import { describeFinding, findingFacts } from "../../api/receivingMessages";
import { LabelCard } from "./LabelCard";

export function LastScan({ result, labels }: { result: ScanResult; labels: Record<string, CartonLabel> }) {
  return (
    <Card title="Last scan">
      <p>
        <strong>{result.accepted ? "Received" : "Not received"}</strong>
      </p>
      {result.cartons.map((c) => (
        <p key={c.lpn} className="floor-pick__progress">
          Carton <span className="floor-mono">{c.lpn}</span>: {c.contents.map((x) => `${x.qty} ${x.qty === 1 ? "each" : "eaches"} of ${x.sku}`).join(", ")}
        </p>
      ))}
      {result.discrepancies.map((d, i) => {
        const copy = describeFinding(d);
        const facts = findingFacts(d);
        return (
          <div key={`${d.kind}-${i}`} className={`floor-notice floor-notice--${copy.tone}`} role="alert" data-finding={d.kind}>
            <p className="floor-notice__what">{copy.title}</p>
            {facts.length > 0 && <p className="floor-muted">{facts.join(" \u2022 ")}</p>}
            <p className="floor-notice__todo">{copy.todo}</p>
          </div>
        );
      })}
      {Object.values(labels).map((l) => (
        <LabelCard key={l.lpn} label={l} />
      ))}
    </Card>
  );
}
