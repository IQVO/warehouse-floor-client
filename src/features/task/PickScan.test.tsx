import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { PickScanResult, Task } from "../../api/fulfillmentExecution";
import { createHarness, PICK_TASK, renderApp, seedStation, STATION, type Harness } from "../../test/renderApp";
import { jsonResponse, noContent, problemResponse } from "../../test/fetchStub";

const B = "/api/fulfillment-execution";
const SCANS = (id: string) => `POST ${B}/tasks/${id}/scans`;
const COMPLETE = (id: string) => `POST ${B}/tasks/${id}/complete`;
const BREAK = (id: string) => `POST ${B}/tasks/${id}/break-case`;
const GS = "\u001d";
const CASE_GTIN = "13041090004824";
const EACH_GTIN = "03041090004827";

const BREAK_TASK: Task = { id: "t-break", type: "BREAK_CASE", status: "CLAIMED", orderRef: "order-42", requiredCapabilities: ["pick"] };

function held(h: Harness, task: Task) {
  seedStation(h.store, {
    station: STATION,
    occupantId: "worker-42",
    held: { task, leaseDurationMs: 300_000, leaseExpiresAt: Date.now() + 300_000 },
  });
}

/** What a wedge does: the text lands in the focused field, then Enter. fireEvent keeps control characters (GS) intact. */
function wedge(label: string | RegExp, code: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: code } });
  fireEvent.keyDown(input, { key: "Enter" });
}

const result = (over: Partial<PickScanResult>): PickScanResult => ({
  scannedGtin: EACH_GTIN,
  sku: "SKU-1",
  level: "EACH",
  addedEaches: 1,
  pickedEaches: 1,
  plannedEaches: 12,
  ...over,
});

describe("PICK scan-confirm", () => {
  it("each scan posts {stationId, gtin(14), count:1} with its own Idempotency-Key and shows the running total in eaches", async () => {
    const h = createHarness();
    held(h, PICK_TASK);
    let picked = 0;
    h.fetchStub.on(SCANS(PICK_TASK.id), () => jsonResponse(200, result({ pickedEaches: ++picked })));
    renderApp(h, "/task");

    wedge("Scan the order label", `]E0${"3041090004827"}`);
    await screen.findByText(/Picked 1 of 12 eaches \(SKU-1\)\./);
    wedge("Scan the order label", "3041090004827");
    await screen.findByText(/Picked 2 of 12 eaches/);

    const calls = h.fetchStub.callsTo(SCANS(PICK_TASK.id));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual({ stationId: "station-1", gtin: EACH_GTIN, count: 1 });
    // Two physical scans of the same code are two actions: two keys.
    expect(calls[0]?.headers["idempotency-key"]).toBeTruthy();
    expect(calls[0]?.headers["idempotency-key"]).not.toBe(calls[1]?.headers["idempotency-key"]);
    expect(h.outbox.list()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Complete task" })).toBeDisabled(); // the order label is still owed
  });

  it("a GS1-128 case label (GS-separated lot, expiry, AI 37) sends only the 14-digit GTIN and count 1", async () => {
    const h = createHarness();
    held(h, PICK_TASK);
    h.fetchStub.on(SCANS(PICK_TASK.id), jsonResponse(200, result({ scannedGtin: CASE_GTIN, level: "CASE", addedEaches: 12, pickedEaches: 12, plannedEaches: 24 })));
    renderApp(h, "/task");

    wedge("Scan the order label", `]C101${CASE_GTIN}3712${GS}10LOT-A1B2${GS}17261231`);
    await screen.findByText(/Picked 12 of 24 eaches/);
    expect(h.fetchStub.callsTo(SCANS(PICK_TASK.id))[0]?.body).toEqual({ stationId: "station-1", gtin: CASE_GTIN, count: 1 });
  });

  it("the order label and the complete step still work after item scans", async () => {
    const h = createHarness();
    held(h, PICK_TASK);
    h.fetchStub.on(SCANS(PICK_TASK.id), jsonResponse(200, result({ pickedEaches: 12 })));
    h.fetchStub.on(COMPLETE(PICK_TASK.id), noContent());
    renderApp(h, "/task");
    wedge("Scan the order label", "3041090004827");
    await screen.findByText(/Picked 12 of 12/);
    wedge("Scan the order label", "order-42");
    await waitFor(() => expect(screen.getByRole("button", { name: "Complete task" })).toBeEnabled());
    await userEvent.setup().click(screen.getByRole("button", { name: "Complete task" }));
    expect(await screen.findByText(`Task ${PICK_TASK.id} completed.`)).toBeInTheDocument();
    expect(h.fetchStub.callsTo(COMPLETE(PICK_TASK.id))[0]?.body).toEqual({ stationId: "station-1" });
  });

  it.each([
    ["scan-level-mismatch", /case where single items are picked/],
    ["scan-sku-mismatch", /not the item for this pick/],
    ["pick-over-quantity", /more than this task asks for/],
    ["unknown-gtin", /does not know that barcode/],
    ["invalid-scanned-gtin", /not a valid product code/],
    ["no-pick-plan", /no pick quantity/],
  ])("problem path: 409 %s is said in plain words, nothing is counted and the task stays in hand", async (code, words) => {
    const h = createHarness();
    held(h, PICK_TASK);
    h.fetchStub.on(SCANS(PICK_TASK.id), problemResponse(409, code, "Engineer title", "usecases: engineer wording"));
    renderApp(h, "/task");
    wedge("Scan the order label", "3041090004827");

    // The in-flight "sending" banner is also an alert for a moment; wait for the answer's words.
    const said = () => screen.getAllByRole("alert").map((a) => a.textContent).join(" | ");
    await waitFor(() => expect(said()).toMatch(words));
    expect(said()).not.toMatch(/usecases|409|engineer/i);
    expect(screen.getByText(/Scan each item or case as you pick it\./)).toBeInTheDocument();
    expect(screen.queryByText("You are not holding a task.")).not.toBeInTheDocument();
    expect(h.outbox.list()).toHaveLength(0); // a definitive answer is not retried
  });

  it("409 task-not-owner on a scan means the claim is gone: the task is dropped", async () => {
    const h = createHarness();
    held(h, PICK_TASK);
    h.fetchStub.on(SCANS(PICK_TASK.id), problemResponse(409, "task-not-owner", "Not owner"));
    renderApp(h, "/task");
    wedge("Scan the order label", "3041090004827");
    expect(await screen.findByText("You are not holding a task.")).toBeInTheDocument();
  });

  it.each([
    ["a bad check digit", "3041090004828", /misread/],
    ["an SSCC", "340123450000000017", /carton \(SSCC\) label/],
    ["a pallet label (AI 02)", `]C100340123450000000017${"02"}${EACH_GTIN}3712`, /pallet or mixed-carton/],
    ["a weight-priced GTIN", "93041090004820", /Weight-priced/],
    ["text that is no barcode", "hello", /not the right one/],
  ])("%s is refused on the device with no request", async (_name, code, words) => {
    const h = createHarness();
    held(h, PICK_TASK);
    renderApp(h, "/task");
    wedge("Scan the order label", code);
    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(h.fetchStub.calls).toHaveLength(0);
  });

  it("offline: the scan is saved with its key, counted as waiting, and replayed once with that key when the network is back", async () => {
    const h = createHarness();
    held(h, PICK_TASK);
    h.fetchStub.on(SCANS(PICK_TASK.id), jsonResponse(200, result({})));
    renderApp(h, "/task");
    h.connectivity.setBrowserOnline(false);
    window.dispatchEvent(new Event("offline"));
    await screen.findByText("You are offline");

    wedge("Scan the order label", "3041090004827");
    expect(await screen.findByText(/1 scan is saved on this device/)).toBeInTheDocument();
    expect(h.fetchStub.calls).toHaveLength(0);
    const saved = h.outbox.list()[0];
    expect(saved).toMatchObject({ kind: "pick-scan", body: { stationId: "station-1", gtin: EACH_GTIN, count: 1 } });

    h.connectivity.setBrowserOnline(true);
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(h.fetchStub.callsTo(SCANS(PICK_TASK.id))).toHaveLength(1));
    expect(h.fetchStub.calls[0]?.headers["idempotency-key"]).toBe(saved?.key);
    await waitFor(() => expect(h.outbox.list()).toHaveLength(0));
  });

  it("a reload with a scan pending replays it with the key it already had", async () => {
    const first = createHarness();
    held(first, PICK_TASK);
    first.fetchStub.on(SCANS(PICK_TASK.id), "network-error");
    const view = renderApp(first, "/task");
    wedge("Scan the order label", "3041090004827");
    await screen.findByText(/1 scan is saved on this device/);
    const savedKey = first.outbox.list()[0]?.key;
    expect(savedKey).toBeTruthy();
    view.unmount();

    const second = createHarness({ store: first.store });
    second.fetchStub.on(SCANS(PICK_TASK.id), jsonResponse(200, result({})));
    renderApp(second, "/task");
    await waitFor(() => expect(second.fetchStub.calls).toHaveLength(1));
    expect(second.fetchStub.calls[0]?.headers["idempotency-key"]).toBe(savedKey);
    await waitFor(() => expect(second.outbox.list()).toHaveLength(0));
  });
});

describe("BREAK_CASE task screen", () => {
  it("shows the break screen (no scan field) and posts {stationId} to /break-case with a key, then ends the task", async () => {
    const h = createHarness();
    held(h, BREAK_TASK);
    h.fetchStub.on(BREAK(BREAK_TASK.id), noContent());
    renderApp(h, "/task");
    expect(screen.getByRole("heading", { name: /BREAK_CASE task/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete task" })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Break case" }));
    expect(await screen.findByText("Case broken. Task t-break completed.")).toBeInTheDocument();
    const call = h.fetchStub.callsTo(BREAK(BREAK_TASK.id))[0];
    expect(call?.body).toEqual({ stationId: "station-1" });
    expect(call?.headers["idempotency-key"]).toMatch(/\S{8,}/);
    expect(screen.getByText("You are not holding a task.")).toBeInTheDocument();
    expect(h.outbox.list()).toHaveLength(0);
  });

  it.each([
    ["case-break-rejected", /refused to break this case/],
    ["not-case-break-task", /not a case-break task/],
    ["case-break-completion-required", /Break case button/],
  ])("problem path: 409 %s is said in plain words and the task stays in hand", async (code, words) => {
    const h = createHarness();
    held(h, BREAK_TASK);
    h.fetchStub.on(BREAK(BREAK_TASK.id), problemResponse(409, code, "Engineer title", "ports: engineer wording"));
    renderApp(h, "/task");
    await userEvent.setup().click(screen.getByRole("button", { name: "Break case" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(words);
    expect(alert.textContent).not.toMatch(/ports:|409/);
    expect(screen.getByRole("button", { name: "Break case" })).toBeEnabled();
    expect(h.outbox.list()).toHaveLength(0);
  });

  it("503 case-break-unavailable is retried, not shown as a failure: saved with its key, and a reload replays that same key (inventory-storage dedupes by task)", async () => {
    const first = createHarness();
    held(first, BREAK_TASK);
    first.fetchStub.on(BREAK(BREAK_TASK.id), problemResponse(503, "case-break-unavailable", "Unavailable"));
    const user = userEvent.setup();
    const view = renderApp(first, "/task");
    await user.click(screen.getByRole("button", { name: "Break case" }));
    expect(await screen.findByText("Case break saved on this device.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Break case" })).not.toBeInTheDocument();
    const savedKey = first.outbox.list()[0]?.key;
    expect(first.outbox.list()[0]).toMatchObject({ kind: "break-case", dedupeId: `break-case:${BREAK_TASK.id}` });
    view.unmount();

    const second = createHarness({ store: first.store });
    second.fetchStub.on(BREAK(BREAK_TASK.id), noContent());
    renderApp(second, "/task");
    await waitFor(() => expect(second.fetchStub.calls).toHaveLength(1));
    expect(second.fetchStub.calls[0]?.headers["idempotency-key"]).toBe(savedKey);
    expect(await screen.findByText("You are not holding a task.")).toBeInTheDocument();
  });

  it("offline: the break is saved and sent once on reconnect with the saved key", async () => {
    const h = createHarness();
    held(h, BREAK_TASK);
    h.fetchStub.on(BREAK(BREAK_TASK.id), noContent());
    renderApp(h, "/task");
    h.connectivity.setBrowserOnline(false);
    window.dispatchEvent(new Event("offline"));
    await screen.findByText("You are offline");
    await userEvent.setup().click(screen.getByRole("button", { name: "Break case" }));
    await screen.findByText("Case break saved on this device.");
    expect(h.fetchStub.calls).toHaveLength(0);
    const key = h.outbox.list()[0]?.key;
    h.connectivity.setBrowserOnline(true);
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(h.fetchStub.callsTo(BREAK(BREAK_TASK.id))).toHaveLength(1));
    expect(h.fetchStub.calls[0]?.headers["idempotency-key"]).toBe(key);
    expect(await screen.findByText("You are not holding a task.")).toBeInTheDocument();
  });

  it("a replay answered 409 task-already-completed ends cleanly", async () => {
    const first = createHarness();
    held(first, BREAK_TASK);
    first.fetchStub.on(BREAK(BREAK_TASK.id), "network-error");
    const view = renderApp(first, "/task");
    await userEvent.setup().click(screen.getByRole("button", { name: "Break case" }));
    await screen.findByText("Case break saved on this device.");
    view.unmount();
    const second = createHarness({ store: first.store });
    second.fetchStub.on(BREAK(BREAK_TASK.id), problemResponse(409, "task-already-completed", "Done"));
    renderApp(second, "/task");
    expect(await screen.findByText("This task was already completed.")).toBeInTheDocument();
  });
});
