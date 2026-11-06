import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { YARD_PREFS_KEY } from "./yardPrefs";
import { createHarness, renderApp, type Harness } from "../../test/renderApp";
import { jsonResponse } from "../../test/fetchStub";
import { YB, checkIn, move, trailer, visit, yardProblem } from "../../test/yardFixtures";

// Form-heavy flows type a lot; keep slow or shared CI runners from tripping the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

function wedge(label: string, code: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: code } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function atGate(h = createHarness()): Harness {
  h.store.setItem(YARD_PREFS_KEY, JSON.stringify({ siteId: "WH1", hostlerRef: "" }));
  return h;
}

/** Fills the check-in form for a live unload with an appointment and one scanned trailer. */
async function fillCheckIn(user: ReturnType<typeof userEvent.setup>, opts: { appointment?: string } = {}) {
  await user.type(screen.getByLabelText("Carrier"), "Acme Freight");
  await user.type(screen.getByLabelText("Carrier code (optional)"), "acme");
  await user.type(screen.getByLabelText("Tractor plate"), "abc1234");
  if (opts.appointment !== undefined) await user.type(screen.getByLabelText("Appointment id (optional)"), opts.appointment);
  await user.selectOptions(screen.getByLabelText("Purpose"), "LIVE_UNLOAD");
  wedge("Scan the trailer unit number", "TRL-4471");
  await user.selectOptions(await screen.findByLabelText("Kind of trailer 1"), "DRY_VAN");
  await user.selectOptions(screen.getByLabelText("Load state 1"), "LOADED");
  await user.type(screen.getByLabelText("Seal number 1 (optional)"), "S-100");
}

const CHECK_IN_BODY = {
  siteId: "WH1",
  carrier: "Acme Freight",
  carrierScac: "ACME",
  tractorPlate: "ABC1234",
  purpose: "LIVE_UNLOAD",
  appointmentId: "appt-1",
  trailers: [{ unitNumber: "TRL-4471", kind: "DRY_VAN", loadState: "LOADED", sealNumber: "S-100" }],
};

describe("gate clerk: check in", () => {
  it("happy path: appointment + one scanned trailer, sent once with a key, and the driver is told where to go", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, jsonResponse(201, checkIn()));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user, { appointment: "appt-1" });
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));

    expect(await screen.findByText("ABC1234 is checked in.")).toBeInTheDocument();
    const [call] = h.fetchStub.callsTo(`POST ${YB}/visits`);
    expect(call?.body).toEqual(CHECK_IN_BODY);
    expect(call?.headers["idempotency-key"]).toMatch(/^key-/);
    expect(screen.getByText(/Take TRL-4471 to Door WH1-DOCK-IN-01 \(to a door\)/)).toBeInTheDocument();
    // The form is empty again, ready for the next truck.
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("");
  });

  it("an appointment with two trailers is refused before anything is sent", async () => {
    const h = atGate();
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user, { appointment: "appt-1" });
    // With an appointment and one trailer the scan field is closed: remove it, scan two without the id, then name one.
    await user.clear(screen.getByLabelText("Appointment id (optional)"));
    wedge("Scan the trailer unit number", "TRL-4472");
    await user.type(screen.getByLabelText("Appointment id (optional)"), "appt-1");
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A visit with an appointment brings exactly one trailer.");
    expect(h.fetchStub.calls).toHaveLength(0);
  });

  it("without an appointment two trailers go in one request", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, jsonResponse(201, checkIn()));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await new Promise((r) => setTimeout(r, 450)); // past the scanner de-bounce
    wedge("Scan the trailer unit number", "TRL-4472");
    await user.selectOptions(await screen.findByLabelText("Kind of trailer 2"), "REEFER");
    await user.selectOptions(screen.getByLabelText("Load state 2"), "EMPTY");
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    await screen.findByText("ABC1234 is checked in.");
    const body = h.fetchStub.callsTo(`POST ${YB}/visits`)[0]?.body as { trailers: unknown[]; appointmentId?: string };
    expect(body.trailers).toHaveLength(2);
    expect(body.appointmentId).toBeUndefined();
  });

  it("a product barcode scanned as a unit number is refused in words", async () => {
    const h = atGate();
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.selectOptions(screen.getByLabelText("Purpose"), "DROP");
    wedge("Scan the trailer unit number", "340123450000000017");
    expect(await screen.findByRole("alert")).toHaveTextContent("That is a product or carton barcode, not a trailer unit number.");
    expect(screen.queryByLabelText("Kind of trailer 1")).not.toBeInTheDocument();
  });

  it("a bobtail lists no trailer and sends none", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, jsonResponse(201, checkIn({ visit: visit({ purpose: "BOBTAIL" }), trailers: [], moves: [] })));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.type(screen.getByLabelText("Carrier"), "Acme");
    await user.type(screen.getByLabelText("Tractor plate"), "bob1");
    await user.selectOptions(screen.getByLabelText("Purpose"), "BOBTAIL");
    expect(screen.queryByLabelText("Scan the trailer unit number")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    await screen.findByText(/is checked in/);
    expect(h.fetchStub.callsTo(`POST ${YB}/visits`)[0]?.body).toEqual({ siteId: "WH1", carrier: "Acme", tractorPlate: "BOB1", purpose: "BOBTAIL" });
  });

  it("problem path: no free spot is explained in plain words, never as raw JSON, and the form keeps what was typed", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, yardProblem(409, "no-free-spot", "No free spot", "usecases: no free spot"));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("There is no free parking spot in the yard right now.");
    expect(alert).toHaveTextContent("Hold the truck at the gate");
    expect(alert.textContent).not.toMatch(/usecases|\{|409/);
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("abc1234");
  });

  it("a seal mismatch under the REJECT policy comes back as a REJECTED visit and is shown as turned away", async () => {
    const h = atGate();
    const rejected = checkIn({ visit: visit({ state: "REJECTED", rejectionReason: "SEAL_MISMATCH" }), trailers: [], moves: [] });
    h.fetchStub.on(`POST ${YB}/visits`, jsonResponse(201, rejected));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user, { appointment: "appt-1" });
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Turned away: The seal does not match.");
    expect(screen.queryByText("Where the driver goes")).not.toBeInTheDocument();
  });

  it("the site code is typed once and remembered on the device", async () => {
    const h = createHarness();
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the site code first.");
    await user.type(screen.getByLabelText("Site code"), "WH1");
    expect(JSON.parse(h.store.getItem(YARD_PREFS_KEY) ?? "{}")).toMatchObject({ siteId: "WH1" });
  });

  it("offline: the check-in is saved, a second tap reuses the key, and the replay after a reload shows the answer", async () => {
    const h = atGate(createHarness({ online: false }));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user, { appointment: "appt-1" });
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    expect(await screen.findByText(/Your check-in is saved on this device/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    expect(h.outbox.list()).toHaveLength(1);
    const key = h.outbox.list()[0]?.key;

    // The page reloads (same store), the network is back: the saved command is replayed with its key.
    const h2 = createHarness({ store: h.store });
    h2.fetchStub.on(`POST ${YB}/visits`, jsonResponse(201, checkIn()));
    renderApp(h2, "/yard/gate");
    expect(await screen.findByText("ABC1234 is checked in.")).toBeInTheDocument();
    expect(h2.fetchStub.callsTo(`POST ${YB}/visits`)[0]?.headers["idempotency-key"]).toBe(key);
    expect(h2.outbox.list()).toHaveLength(0);
  });
});

describe("gate clerk: reject at the gate", () => {
  it("records the refusal with the reason", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visit-rejections`, jsonResponse(201, visit({ state: "REJECTED", rejectionReason: "APPOINTMENT_REQUIRED" })));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.type(screen.getByLabelText("Carrier"), "Acme");
    await user.type(screen.getByLabelText("Tractor plate"), "abc1234");
    await user.click(screen.getByRole("button", { name: "Reject at the gate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose why the truck is turned away.");
    await user.selectOptions(screen.getByLabelText("Reason"), "APPOINTMENT_REQUIRED");
    await user.click(screen.getByRole("button", { name: "Reject at the gate" }));
    expect(await screen.findByText(/was turned away and the refusal is recorded/)).toBeInTheDocument();
    const [call] = h.fetchStub.callsTo(`POST ${YB}/visit-rejections`);
    expect(call?.body).toEqual({ siteId: "WH1", carrier: "Acme", tractorPlate: "ABC1234", reason: "APPOINTMENT_REQUIRED" });
    expect(call?.headers["idempotency-key"]).toBeTruthy();
  });

  it("problem path: a refusal the service cannot record is explained", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visit-rejections`, yardProblem(422, "invalid-carrier", "Invalid carrier"));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.type(screen.getByLabelText("Carrier"), "Acme");
    await user.type(screen.getByLabelText("Tractor plate"), "abc1234");
    await user.selectOptions(screen.getByLabelText("Reason"), "SITE_REQUEST");
    await user.click(screen.getByRole("button", { name: "Reject at the gate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The carrier details are not valid.");
  });
});

describe("gate clerk: check out", () => {
  const LIVE = visit({ visitId: "visit-1", tractorPlate: "ABC1234", purpose: "LIVE_UNLOAD" });
  const READY = trailer({ trailerId: "trl-1", unitNumber: "TRL-4471", state: "DOCKED", location: { kind: "DOOR", code: "WH1-DOCK-IN-01" }, doorWork: "DONE", openMoveId: null });
  const BUSY = trailer({ trailerId: "trl-2", unitNumber: "TRL-9", visitId: "visit-1", state: "DOCKED", location: { kind: "DOOR", code: "WH1-DOCK-IN-02" }, doorWork: "IN_PROGRESS", openMoveId: null });

  function stubLists(h: Harness, trailers = [READY]) {
    h.fetchStub.on(`GET ${YB}/visits?siteId=WH1&state=CHECKED_IN&limit=500`, jsonResponse(200, { items: [LIVE, visit({ visitId: "visit-2", tractorPlate: "ZZZ999", purpose: "DROP" })] }));
    h.fetchStub.on(`GET ${YB}/trailers?siteId=WH1&limit=500`, jsonResponse(200, { items: trailers }));
  }

  it("a live visit leaves with its ready trailer; the request names exactly the ticked trailers", async () => {
    const h = atGate();
    stubLists(h, [READY, BUSY]);
    h.fetchStub.on(`POST ${YB}/visits/visit-1/check-outs`, jsonResponse(200, visit({ state: "CHECKED_OUT", trailersOut: ["trl-1"] })));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await user.type(await screen.findByLabelText("Tractor plate"), "abc");
    expect(screen.queryByText(/ZZZ999/)).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "ABC1234" }));

    expect(await screen.findByLabelText("Take out TRL-4471")).toBeChecked();
    expect(screen.getByLabelText("Take out TRL-9")).not.toBeChecked();
    expect(screen.getByText(/not ready: door work is not finished/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check out this truck" }));
    expect(await screen.findByText("ABC1234 is checked out.")).toBeInTheDocument();
    expect(h.fetchStub.callsTo(`POST ${YB}/visits/visit-1/check-outs`)[0]?.body).toEqual({ trailersOut: [{ trailerId: "trl-1" }] });
  });

  it("a drop leaves its trailer in the yard (empty trailersOut)", async () => {
    const h = atGate();
    stubLists(h, [trailer({ trailerId: "trl-5", visitId: "visit-2", state: "PARKED", openMoveId: null, location: { kind: "SPOT", code: "WH1-YARD-01" } })]);
    h.fetchStub.on(`POST ${YB}/visits/visit-2/check-outs`, jsonResponse(200, visit({ visitId: "visit-2", state: "CHECKED_OUT", tractorPlate: "ZZZ999" })));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await user.click(await screen.findByRole("button", { name: "ZZZ999" }));
    expect(await screen.findByLabelText("Take out TRL-4471")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Check out this truck" }));
    await screen.findByText("ZZZ999 is checked out.");
    expect(h.fetchStub.callsTo(`POST ${YB}/visits/visit-2/check-outs`)[0]?.body).toEqual({ trailersOut: [] });
  });

  it("problem path: trailer-not-released is explained and the choice stays", async () => {
    const h = atGate();
    stubLists(h);
    h.fetchStub.on(`POST ${YB}/visits/visit-1/check-outs`, yardProblem(409, "trailer-not-released", "Trailer is not released"));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await user.click(await screen.findByRole("button", { name: "ABC1234" }));
    await user.click(await screen.findByRole("button", { name: "Check out this truck" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A trailer is not ready to leave");
    expect(screen.getByLabelText("Take out TRL-4471")).toBeChecked();
  });

  it("a pickup scans the unit number of a parked trailer to take it out", async () => {
    const h = atGate();
    const parked = trailer({ trailerId: "trl-7", unitNumber: "TRL-7", visitId: "visit-0", state: "PARKED", openMoveId: null, location: { kind: "SPOT", code: "WH1-YARD-03" } });
    h.fetchStub.on(`GET ${YB}/visits?siteId=WH1&state=CHECKED_IN&limit=500`, jsonResponse(200, { items: [visit({ visitId: "visit-3", tractorPlate: "PIK1", purpose: "PICKUP", trailersIn: [] })] }));
    h.fetchStub.on(`GET ${YB}/trailers?siteId=WH1&limit=500`, jsonResponse(200, { items: [parked] }));
    h.fetchStub.on(`POST ${YB}/visits/visit-3/check-outs`, jsonResponse(200, visit({ visitId: "visit-3", tractorPlate: "PIK1", state: "CHECKED_OUT" })));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    await user.click(await screen.findByRole("button", { name: "PIK1" }));
    expect(await screen.findByLabelText("Take out TRL-7")).not.toBeChecked();
    wedge("Scan the unit number of the trailer being picked up", "TRL-NOPE");
    expect(await screen.findByRole("alert")).toHaveTextContent("TRL-NOPE is not one of this visit's trailers.");
    await new Promise((r) => setTimeout(r, 450));
    wedge("Scan the unit number of the trailer being picked up", "trl-7");
    await waitFor(() => expect(screen.getByLabelText("Take out TRL-7")).toBeChecked());
    await user.click(screen.getByRole("button", { name: "Check out this truck" }));
    await screen.findByText("PIK1 is checked out.");
    expect(h.fetchStub.callsTo(`POST ${YB}/visits/visit-3/check-outs`)[0]?.body).toEqual({ trailersOut: [{ trailerId: "trl-7" }] });
  });

  it("says so when the list cannot be loaded", async () => {
    const h = atGate();
    h.fetchStub.on(`GET ${YB}/visits?siteId=WH1&state=CHECKED_IN&limit=500`, yardProblem(500, "internal-error", "Internal"));
    h.fetchStub.on(`GET ${YB}/trailers?siteId=WH1&limit=500`, jsonResponse(200, { items: [] }));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.click(screen.getByRole("button", { name: "Check out" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/unexpected error/)).toBeInTheDocument();
    void move;
  });
});
