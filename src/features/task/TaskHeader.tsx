import { Card, StatusPill } from "@warehouse/ui-kit";
import { LeaseCountdown } from "../../components/LeaseCountdown";
import type { Task } from "../../api/fulfillmentExecution";

export function TaskHeader({
  task,
  remainingMs,
  durationMs,
  renewFailing,
}: {
  task: Task;
  remainingMs: number;
  durationMs: number;
  renewFailing: boolean;
}) {
  return (
    <Card
      title={
        <h2 className="floor-task__title">
          {task.type} task <span className="floor-mono">{task.id}</span>
        </h2>
      }
      actions={<StatusPill status={task.status} />}
    >
      <dl className="floor-facts">
        {task.orderRef && (
          <>
            <dt>Order</dt>
            <dd className="floor-mono">{task.orderRef}</dd>
          </>
        )}
        {task.cpt && (
          <>
            <dt>Due (CPT)</dt>
            <dd>{new Date(task.cpt).toLocaleString()}</dd>
          </>
        )}
        {task.relocation && (
          <>
            <dt>Move</dt>
            <dd>
              {task.relocation.kind} <span className="floor-mono">{task.relocation.sku}</span>
              {task.relocation.fromBin && <> from <span className="floor-mono">{task.relocation.fromBin}</span></>}
              {task.relocation.toBin && <> to <span className="floor-mono">{task.relocation.toBin}</span></>}
            </dd>
          </>
        )}
        {task.replenishment && (
          <>
            <dt>Replenish</dt>
            <dd>
              {task.replenishment.quantity} x <span className="floor-mono">{task.replenishment.sku}</span> from{" "}
              <span className="floor-mono">{task.replenishment.fromBin}</span> to{" "}
              <span className="floor-mono">{task.replenishment.toBin}</span>
              {task.replenishment.priority === "URGENT" && <strong> (URGENT)</strong>}
            </dd>
          </>
        )}
        {task.fragile && (
          <>
            <dt>Handling</dt>
            <dd>Fragile</dd>
          </>
        )}
        {task.giftWrap && (
          <>
            <dt>Handling</dt>
            <dd>Gift wrap</dd>
          </>
        )}
      </dl>
      <LeaseCountdown remainingMs={remainingMs} durationMs={durationMs} renewFailing={renewFailing} />
    </Card>
  );
}
