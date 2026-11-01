import { Card } from "@warehouse/ui-kit";
import type { Task } from "../../api/fulfillmentExecution";
import { useStation } from "../station/stationState";
import { TaskHeader } from "./TaskHeader";

export function BreakCaseWork({
  task,
  remainingMs,
  durationMs,
  renewFailing,
  breakQueued,
  onRetry,
}: {
  task: Task;
  remainingMs: number;
  durationMs: number;
  renewFailing: boolean;
  breakQueued: boolean;
  onRetry: () => void;
}) {
  const { breakCase, busy } = useStation();
  const sending = busy === "break-case";
  return (
    <div className="floor-stack">
      <TaskHeader task={task} remainingMs={remainingMs} durationMs={durationMs} renewFailing={renewFailing} />
      <Card title="Break the sealed case">
        <p>Open the sealed case at the pick face and put the items loose in the bin. Then press Break case.</p>
        <p>The warehouse system updates its stock (the case becomes loose items) and this task is completed in one step.</p>
        {breakQueued ? (
          <output className="floor-notice floor-notice--warning">
            <p className="floor-notice__what">Case break saved on this device.</p>
            <p className="floor-notice__todo">It will be sent when the connection is back. You do not need to repeat it.</p>
            <button type="button" className="floor-btn" onClick={onRetry}>
              Retry now
            </button>
          </output>
        ) : (
          <button
            type="button"
            className="floor-btn floor-btn--primary floor-btn--xl"
            disabled={sending}
            onClick={() => void breakCase()}
          >
            {sending ? "Breaking..." : "Break case"}
          </button>
        )}
      </Card>
    </div>
  );
}
