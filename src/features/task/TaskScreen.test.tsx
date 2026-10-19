import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../api/fulfillmentExecution";
import { createHarness, PICK_TASK, renderApp, seedStation, STATION, type Harness } from "../../test/renderApp";
import { jsonResponse, noContent, problemResponse } from "../../test/fetchStub";

const B = "/api/fulfillment-execution";
const COMPLETE = (id: string) => `POST ${B}/tasks/${id}/complete`;
const RENEW = (id: string) => `POST ${B}/tasks/${id}/renew-lease`;

function held(h: Harness, task: Task, leaseMs = 300_000) {
  seedStation(h.store, {
    station: STATION,
    occupantId: "worker-42",
    held: { task, leaseDurationMs: 300_000, leaseExpiresAt: Date.now() + leaseMs },
  });
}

const RELOCATE_ASSIGN: Task = {
  id: "t-reloc",
  type: "RELOCATE",
  status: "CLAIMED",
  relocation: { planId: "plan-7", moveSeq: 3, kind: "Assign", sku: "SKU-1", toBin: "WH1-FWD-A01-01-02-A", ref: "plan-7:3" },
};
const REPLENISH: Task = {
  id: "t-repl",
  type: "REPLENISH",
  status: "CLAIMED",
  replenishment: { requestId: "req-9", sku: "SKU-1", fromBin: "WH1-RSV-AMB-B02-03-02-C", toBin: "WH1-FWD-AMB-A01-01-01-A", quantity: 24, priority: "URGENT" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("task screen", () => {
  it("with no task in hand it points back to the station screen", () => {
    const h = createHarness();
    seedStation(h.store, { station: STATION });
    renderApp(h, "/task");
    expect(screen.getByText("You are not holding a task.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pull the next task" })).toHaveAttribute("href", "/");
  });

  it("happy path (PICK): a wrong scan is refused, the right scan unlocks Complete, which posts with an Idempotency-Key", async () => {
    const h = createHarness();
    held(h, PICK_TASK);
    h.fetchStub.on(COMPLETE(PICK_TASK.id), noContent());
    const user = userEvent.setup();
    renderApp(h, "/task");

    const complete = screen.getByRole("button", { name: "Complete task" });
    expect(complete).toBeDisabled();
    expect(screen.getByText("order-42")).toBeInTheDocument();

    const scan = screen.getByLabelText("Scan the order label");
    await user.type(scan, "order-99{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("That is not the right one");
    expect(complete).toBeDisabled();

    await user.type(screen.getByLabelText("Scan the order label"), "ORDER-42{Enter}"); // case-insensitive
    await waitFor(() => expect(screen.getByRole("button", { name: "Complete task" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Complete task" }));

    expect(await screen.findByText(`Task ${PICK_TASK.id} completed.`)).toBeInTheDocument();
    const call = h.fetchStub.callsTo(COMPLETE(PICK_TASK.id))[0];
    expect(call?.body).toEqual({ stationId: "station-1" });
    expect(call?.headers["idempotency-key"]).toMatch(/\S{8,}/);
    expect(screen.getByText("You are not holding a task.")).toBeInTheDocument();
    expect(h.outbox.list()).toHaveLength(0);
  });

  it("problem path: 409 task-not-claimed on complete says the claim is gone and drops the task", async () => {
    const h = createHarness();
    held(h, PICK_TASK);
    h.fetchStub.on(COMPLETE(PICK_TASK.id), problemResponse(409, "task-not-claimed", "Task is not currently claimed", "task: not claimed"));
    const user = userEvent.setup();
    renderApp(h, "/task");
    await user.type(screen.getByLabelText("Scan the order label"), "order-42{Enter}");
    await user.click(await screen.findByRole("button", { name: "Complete task" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You no longer hold this task");
    expect(alert).toHaveTextContent("Pull the next task.");
    expect(alert.textContent).not.toMatch(/task: not claimed|409/);
    expect(screen.getByText("You are not holding a task.")).toBeInTheDocument();
  });

  it("409 task-already-completed is treated as done, not as a failure", async () => {
    const h = createHarness();
    held(h, PICK_TASK);
    h.fetchStub.on(COMPLETE(PICK_TASK.id), problemResponse(409, "task-already-completed", "Task already completed", "task: already completed"));
    const user = userEvent.setup();
    renderApp(h, "/task");
    await user.type(screen.getByLabelText("Scan the order label"), "order-42{Enter}");
    await user.click(await screen.findByRole("button", { name: "Complete task" }));
    expect(await screen.findByText("This task was already completed.")).toBeInTheDocument();
    expect(screen.getByText("You are not holding a task.")).toBeInTheDocument();
  });

  it("RELOCATE (Assign): scans the open source bin, the planned destination, a quantity, and sends all three", async () => {
    const h = createHarness();
    held(h, RELOCATE_ASSIGN);
    h.fetchStub.on(COMPLETE("t-reloc"), noContent());
    const user = userEvent.setup();
    renderApp(h, "/task");

    await user.type(screen.getByLabelText("Scan the bin you took it from"), "WH1-RSV-B02-01-01-A{Enter}");
    // the planned destination must match
    await user.type(await screen.findByLabelText("Scan the destination bin"), "WH1-WRONG{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("That is not the right one");
    await user.type(screen.getByLabelText("Scan the destination bin"), "wh1-fwd-a01-01-02-a{Enter}");

    const qty = await screen.findByLabelText("Quantity you moved");
    expect(screen.getByRole("button", { name: "Complete task" })).toBeDisabled();
    await user.type(qty, "12");
    await user.click(screen.getByRole("button", { name: "Complete task" }));

    await screen.findByText("Task t-reloc completed.");
    expect(h.fetchStub.callsTo(COMPLETE("t-reloc"))[0]?.body).toEqual({
      stationId: "station-1",
      quantity: 12,
      fromBin: "WH1-RSV-B02-01-01-A",
      toBin: "WH1-FWD-A01-01-02-A", // the planned spelling, not the lower-case scan
    });
  });

  it("REPLENISH: quantity defaults to the plan; a 422 keeps the task in hand and explains what to fix", async () => {
    const h = createHarness();
    held(h, REPLENISH);
    h.fetchStub.on(COMPLETE("t-repl"), problemResponse(422, "invalid-replenishment-confirmation", "Invalid replenishment confirmation", "task: invalid"));
    const user = userEvent.setup();
    renderApp(h, "/task");
    expect(screen.getByText(/URGENT/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Scan the reserve bin"), "WH1-RSV-AMB-B02-03-02-C{Enter}");
    await user.type(await screen.findByLabelText("Scan the pick face"), "WH1-FWD-AMB-A01-01-01-A{Enter}");
    expect(await screen.findByLabelText("Quantity you moved")).toHaveValue(24);
    await user.click(screen.getByRole("button", { name: "Complete task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The quantity or a scanned bin does not fit the replenishment.");
    // the task is still held: the operator can fix it and retry
    expect(screen.getByRole("button", { name: "Complete task" })).toBeEnabled();
    expect(h.fetchStub.callsTo(COMPLETE("t-repl"))[0]?.body).toEqual({
      stationId: "station-1",
      quantity: 24,
      fromBin: "WH1-RSV-AMB-B02-03-02-C",
      toBin: "WH1-FWD-AMB-A01-01-01-A",
    });
  });

  it("a PACK task cannot be finished here: no Complete button, and it says why", () => {
    const h = createHarness();
    held(h, { id: "t-pack", type: "PACK", status: "CLAIMED", orderRef: "order-42" });
    renderApp(h, "/task");
    expect(screen.getByText(/PACK tasks are finished on their own screens/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete task" })).not.toBeInTheDocument();
  });
});

describe("lease renewal", () => {
  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("shows a visible countdown and renews at half the lease, each renewal with its own Idempotency-Key", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const h = createHarness();
    held(h, PICK_TASK, 300_000);
    h.fetchStub.on(RENEW(PICK_TASK.id), noContent());
    renderApp(h, "/task");

    expect(screen.getByRole("timer")).toHaveTextContent("5:00");
    await tick(60_000);
    expect(screen.getByRole("timer")).toHaveTextContent("4:00");
    expect(h.fetchStub.callsTo(RENEW(PICK_TASK.id))).toHaveLength(0);

    await tick(91_000); // past the half-way mark (2:30 left)
    const renewals = h.fetchStub.callsTo(RENEW(PICK_TASK.id));
    expect(renewals).toHaveLength(1);
    expect(renewals[0]?.body).toEqual({ stationId: "station-1" });
    expect(renewals[0]?.headers["idempotency-key"]).toBeTruthy();
    // renewed: the countdown went back up to a full lease
    expect(screen.getByRole("timer")).toHaveTextContent(/^(5:00|4:5\d)$/);

    await tick(160_000);
    const again = h.fetchStub.callsTo(RENEW(PICK_TASK.id));
    expect(again).toHaveLength(2);
    expect(again[1]?.headers["idempotency-key"]).not.toBe(again[0]?.headers["idempotency-key"]);
  });

  it("problem path: a 409 on renewal means the claim is lost; the screen says so and drops the task", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const h = createHarness();
    held(h, PICK_TASK, 100_000);
    h.fetchStub.on(RENEW(PICK_TASK.id), problemResponse(409, "task-not-claimed", "Task is not currently claimed", "task: not claimed"));
    renderApp(h, "/task");
    await tick(2_000);
    expect(screen.getByRole("alert")).toHaveTextContent("You no longer hold this task");
    expect(screen.getByText("You are not holding a task.")).toBeInTheDocument();
  });

  it("when renewal cannot reach the server the countdown warns, and the next attempt is not a retry storm", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const h = createHarness();
    held(h, PICK_TASK, 100_000);
    h.fetchStub.on(RENEW(PICK_TASK.id), "network-error");
    renderApp(h, "/task");
    await tick(2_000);
    expect(screen.getByText(/Could not renew/)).toBeInTheDocument();
    await tick(5_000);
    expect(h.fetchStub.callsTo(RENEW(PICK_TASK.id))).toHaveLength(1);
    await tick(10_000);
    expect(h.fetchStub.callsTo(RENEW(PICK_TASK.id)).length).toBeGreaterThanOrEqual(2);
    // and a renewal that failed is never put in the outbox
    expect(h.outbox.list()).toHaveLength(0);
  });

  it("an expired lease is shown as such", () => {
    const h = createHarness();
    held(h, PICK_TASK, -5_000);
    renderApp(h, "/task");
    expect(screen.getByRole("timer")).toHaveTextContent("0:00");
    expect(screen.getByText(/Your claim has run out/)).toBeInTheDocument();
  });
});

describe("offline completion", () => {
  it("queues the completion with its key, shows the banner, and replays the SAME key on reconnect", async () => {
    const h = createHarness();
    held(h, PICK_TASK);
    h.fetchStub.on(COMPLETE(PICK_TASK.id), noContent());
    const user = userEvent.setup();
    renderApp(h, "/task");
    await user.type(screen.getByLabelText("Scan the order label"), "order-42{Enter}");

    h.connectivity.setBrowserOnline(false);
    window.dispatchEvent(new Event("offline"));
    expect(await screen.findByText("You are offline")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Complete task" }));
    expect(await screen.findByText("Completion saved on this device.")).toBeInTheDocument();
    expect(h.fetchStub.calls).toHaveLength(0);
    const saved = h.outbox.list()[0];
    expect(saved?.kind).toBe("complete");

    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(h.fetchStub.callsTo(COMPLETE(PICK_TASK.id))).toHaveLength(1));
    expect(h.fetchStub.calls[0]?.headers["idempotency-key"]).toBe(saved?.key);
    expect(await screen.findByText("You are not holding a task.")).toBeInTheDocument();
    expect(screen.queryByText("You are offline")).not.toBeInTheDocument();
  });

  it("a reload while the completion is pending replays it with the key it already had (no new key is minted)", async () => {
    // page 1: the request is lost
    const first = createHarness();
    held(first, PICK_TASK);
    first.fetchStub.on(COMPLETE(PICK_TASK.id), "network-error");
    const user = userEvent.setup();
    const view = renderApp(first, "/task");
    await user.type(screen.getByLabelText("Scan the order label"), "order-42{Enter}");
    await user.click(await screen.findByRole("button", { name: "Complete task" }));
    expect(await screen.findByText("Completion saved on this device.")).toBeInTheDocument();
    const savedKey = first.outbox.list()[0]?.key;
    expect(savedKey).toBeTruthy();
    view.unmount();

    // page 2: same storage, brand-new everything else; the network is back
    const second = createHarness({ store: first.store });
    second.fetchStub.on(COMPLETE(PICK_TASK.id), noContent());
    renderApp(second, "/task");
    await waitFor(() => expect(second.fetchStub.calls).toHaveLength(1));
    expect(second.fetchStub.calls[0]?.headers["idempotency-key"]).toBe(savedKey);
    expect(await screen.findByText("You are not holding a task.")).toBeInTheDocument();
    expect(second.outbox.list()).toHaveLength(0);
  });

  it("a replay answered 409 task-already-completed (the first attempt got through) ends cleanly", async () => {
    const first = createHarness();
    held(first, PICK_TASK);
    first.fetchStub.on(COMPLETE(PICK_TASK.id), "network-error");
    const user = userEvent.setup();
    const view = renderApp(first, "/task");
    await user.type(screen.getByLabelText("Scan the order label"), "order-42{Enter}");
    await user.click(await screen.findByRole("button", { name: "Complete task" }));
    await screen.findByText("Completion saved on this device.");
    view.unmount();

    const second = createHarness({ store: first.store });
    second.fetchStub.on(COMPLETE(PICK_TASK.id), problemResponse(409, "task-already-completed", "Task already completed", "task: already completed"));
    renderApp(second, "/task");
    expect(await screen.findByText("This task was already completed.")).toBeInTheDocument();
    expect(screen.getByText("You are not holding a task.")).toBeInTheDocument();
  });
});

describe("claimed task from a queued claim", () => {
  it("a claim-next saved offline lands on the task when it replays (jsonResponse smoke)", async () => {
    const h = createHarness();
    seedStation(h.store, { station: STATION, occupantId: "worker-42" });
    h.fetchStub.on(`POST ${B}/stations/station-1/claim-next`, jsonResponse(200, PICK_TASK));
    h.connectivity.setBrowserOnline(false);
    const user = userEvent.setup();
    renderApp(h);
    await user.click(screen.getByRole("button", { name: "Pick" }));
    expect(await screen.findByText(/Your request is saved on this device/)).toBeInTheDocument();
    window.dispatchEvent(new Event("online"));
    expect(await screen.findByRole("link", { name: "Go to the task" })).toBeInTheDocument();
    expect(screen.getByText(`Task ${PICK_TASK.id} is yours.`)).toBeInTheDocument();
  });
});
