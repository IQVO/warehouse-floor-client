import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, StatusPill } from "@warehouse/ui-kit";
import { LeaseCountdown } from "../../components/LeaseCountdown";
import { ScanInput } from "../../components/ScanInput";
import { usePendingCommands } from "../../app/servicesContext";
import type { PickScanResult, Task } from "../../api/fulfillmentExecution";
import { parseScan, toPickGtin } from "../../lib/gs1";
import { describePickRefusal } from "./scanCopy";
import { useStation } from "../station/stationState";
import { buildConfirmPlan, scanMatches, type ScanStep } from "./confirmPlan";

export function TaskScreen() {
  const { held, station, now, renewFailing, retryNow } = useStation();
  const pending = usePendingCommands();

  if (held === null) {
    return (
      <Card title="No task in hand">
        <p>You are not holding a task.</p>
        <Link className="floor-btn floor-btn--primary" to="/">
          {station ? "Pull the next task" : "Set up this station"}
        </Link>
      </Card>
    );
  }

  const queued = pending.some((e) => (e.kind === "complete" || e.kind === "break-case") && e.meta.taskId === held.task.id);
  const pendingScans = pending.filter((e) => e.kind === "pick-scan" && e.meta.taskId === held.task.id).length;
  if (held.task.type === "BREAK_CASE") {
    return (
      <BreakCaseWork
        key={held.task.id}
        task={held.task}
        remainingMs={held.leaseExpiresAt - now}
        durationMs={held.leaseDurationMs}
        renewFailing={renewFailing}
        breakQueued={queued}
        onRetry={retryNow}
      />
    );
  }
  return (
    // Keyed by task id: a new task starts with a clean confirmation.
    <TaskWork
      pendingScans={pendingScans}
      key={held.task.id}
      task={held.task}
      remainingMs={held.leaseExpiresAt - now}
      durationMs={held.leaseDurationMs}
      renewFailing={renewFailing}
      completionQueued={queued}
      onRetry={retryNow}
    />
  );
}

function TaskWork({
  task,
  remainingMs,
  durationMs,
  renewFailing,
  completionQueued,
  pendingScans,
  onRetry,
}: {
  task: Task;
  remainingMs: number;
  durationMs: number;
  renewFailing: boolean;
  completionQueued: boolean;
  pendingScans: number;
  onRetry: () => void;
}) {
  const { completeTask, scanPick, busy } = useStation();
  const isPick = task.type === "PICK";
  const [progress, setProgress] = useState<PickScanResult | null>(null);
  const plan = useMemo(() => buildConfirmPlan(task), [task]);
  const [scans, setScans] = useState<Partial<Record<ScanStep["id"], string>>>({});
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [quantityText, setQuantityText] = useState<string>(() =>
    plan.supported && plan.quantity?.default !== undefined ? String(plan.quantity.default) : "",
  );

  const header = (
    <TaskHeader task={task} remainingMs={remainingMs} durationMs={durationMs} renewFailing={renewFailing} />
  );

  if (!plan.supported) {
    return (
      <div className="floor-stack">
        {header}
        <Card title="Cannot finish here">
          <p>{plan.reason}</p>
          <p>The lease keeps renewing while this page is open. Ask your lead to move this task.</p>
        </Card>
      </div>
    );
  }

  const nextStep = plan.scans.find((s) => scans[s.id] === undefined);
  const allScanned = nextStep === undefined;
  const quantity = quantityText.trim() === "" ? undefined : Number(quantityText);
  const quantityOk =
    plan.quantity === null || (quantity !== undefined && Number.isInteger(quantity) && quantity >= 1);
  const sameBins = scans.fromBin !== undefined && scans.fromBin.toLowerCase() === scans.toBin?.toLowerCase();

  async function onScan(value: string) {
    if (nextStep !== undefined && scanMatches(nextStep, value)) {
      setMismatch(null);
      // When the plan fixed the value, send the planned spelling so the server's equality check cannot trip on case.
      setScans((s) => ({ ...s, [nextStep.id]: nextStep.expected ?? value }));
      return;
    }
    if (isPick) {
      const parsed = parseScan(value);
      if (parsed.kind === "INVALID" && (parsed.reason === "not-digits" || parsed.reason === "bad-length")) {
        // Neither the order label nor anything shaped like a product code.
        setMismatch(
          `That is not the right one. ${nextStep ? `Scan the order label (${nextStep.expected ?? ""}) or an item or case barcode.` : "Scan an item or case barcode."}`,
        );
        return;
      }
      const gtin = toPickGtin(parsed);
      if (!gtin.ok) {
        setMismatch(describePickRefusal(gtin.reason));
        return;
      }
      setMismatch(null);
      // count is always 1 per physical scan; a case GTIN counts cases, the server multiplies (contract R7).
      const result = await scanPick(gtin.gtin);
      if (result.ok && result.data !== undefined) setProgress(result.data as PickScanResult);
      return;
    }
    if (nextStep !== undefined) {
      setMismatch(`That is not the right one. ${nextStep.label}: ${nextStep.expected ?? ""}`.trim());
    }
  }

  async function complete() {
    if (!plan.supported) return;
    await completeTask(plan.toRequest(scans, plan.quantity === null ? undefined : quantity));
  }

  const sending = busy === "complete";
  return (
    <div className="floor-stack">
      {header}
      <Card title="Confirm with scans">
        <ol className="floor-steps">
          {plan.scans.map((step) => (
            <li key={step.id} className={scans[step.id] ? "floor-steps__done" : undefined}>
              {step.label}
              {scans[step.id] ? (
                <>
                  : <span className="floor-mono">{scans[step.id]}</span>{" "}
                  <button
                    type="button"
                    className="floor-btn floor-btn--quiet"
                    disabled={completionQueued || sending}
                    onClick={() => setScans(({ [step.id]: _dropped, ...rest }) => rest)}
                  >
                    Rescan
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ol>

        {isPick && (
          <p className="floor-pick__progress">
            {progress
              ? `Picked ${progress.pickedEaches} of ${progress.plannedEaches} eaches (${progress.sku}).`
              : "Scan each item or case as you pick it."}
            {pendingScans > 0 && ` ${pendingScans} ${pendingScans === 1 ? "scan is" : "scans are"} saved on this device and will be sent when the connection is back.`}
          </p>
        )}
        {(isPick || !allScanned) && (
          <ScanInput
            label={nextStep ? nextStep.label : "Scan an item or case barcode"}
            hint={
              isPick
                ? "Scan an item or case barcode to count it" + (nextStep ? "; scan the order label when the pick is done." : ".")
                : nextStep?.expected
                  ? "The code must match this task."
                  : undefined
            }
            disabled={busy === "pick-scan"}
            onScan={(v) => void onScan(v)}
          />
        )}
        {mismatch && (
          <p className="floor-error" role="alert">
            {mismatch}
          </p>
        )}
        {allScanned && sameBins && (
          <p className="floor-error" role="alert">
            The source and destination are the same bin. Rescan one of them.
          </p>
        )}

        {allScanned && plan.quantity !== null && (
          <div className="floor-field">
            <label htmlFor="floor-qty">Quantity you moved</label>
            <input
              id="floor-qty"
              className="floor-input"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={quantityText}
              onChange={(e) => setQuantityText(e.target.value)}
            />
          </div>
        )}

        {completionQueued ? (
          <output className="floor-notice floor-notice--warning">
            <p className="floor-notice__what">Completion saved on this device.</p>
            <p className="floor-notice__todo">It will be sent when the connection is back. You do not need to repeat it.</p>
            <button type="button" className="floor-btn" onClick={onRetry}>
              Retry now
            </button>
          </output>
        ) : (
          <button
            type="button"
            className="floor-btn floor-btn--primary floor-btn--xl"
            disabled={!allScanned || !quantityOk || sameBins || sending}
            onClick={() => void complete()}
          >
            {sending ? "Completing..." : "Complete task"}
          </button>
        )}
      </Card>
    </div>
  );
}

function TaskHeader({
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

function BreakCaseWork({
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
