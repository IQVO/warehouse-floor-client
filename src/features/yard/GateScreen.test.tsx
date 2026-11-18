import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { turnAwayTitle, withTurnAway } from "./turnAway";
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

const SUSPENDED = () => yardProblem(409, "carrier-suspended", "The carrier is suspended", "the carrier is suspended: SCAC ACME is suspended; visit vis-0a1b is recorded as REJECTED");

// yard-management ADR 0012, OpenAPI TrailerIn.sealClass (I | S | H, optional, needs a sealNumber). A site whose
// yard policy sets a minimum class refuses a seal with no class (409 seal-class-too-low), so the clerk can state it.
describe("gate clerk: seal strength at check-in", () => {
  const STRENGTH = "Seal strength 1 (optional)";

  it("asks for the strength only once a seal number is typed, in plain words, and sends nothing when it is not stated", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, jsonResponse(201, checkIn()));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.type(screen.getByLabelText("Carrier"), "Acme Freight");
    await user.type(screen.getByLabelText("Tractor plate"), "abc1234");
    await user.selectOptions(screen.getByLabelText("Purpose"), "DROP");
    wedge("Scan the trailer unit number", "TRL-4471");
    await user.selectOptions(await screen.findByLabelText("Kind of trailer 1"), "DRY_VAN");
    await user.selectOptions(screen.getByLabelText("Load state 1"), "LOADED");
    expect(screen.queryByLabelText(STRENGTH)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Seal number 1 (optional)"), "S-100");
    const select = screen.getByLabelText(STRENGTH);
    expect(select).toHaveValue("");
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(["", "I", "S", "H"]);
    expect(options.map((o) => o.textContent)).toEqual(["Not stated", "Light seal: only shows tampering (I)", "Security seal (S)", "High-security seal (H)"]);
    // Words first: no option is a bare letter or a standard number.
    for (const o of options) expect(o.textContent ?? "").not.toMatch(/^[ISH]$|17712|ISO/);

    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    await screen.findByText("ABC1234 is checked in.");
    const sent = h.fetchStub.callsTo(`POST ${YB}/visits`)[0]?.body as { trailers: Record<string, unknown>[] };
    expect(sent.trailers).toEqual([{ unitNumber: "TRL-4471", kind: "DRY_VAN", loadState: "LOADED", sealNumber: "S-100" }]);
    expect(JSON.stringify(sent)).not.toContain("sealClass");
  });

  it("sends the chosen strength as trailers[].sealClass", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, jsonResponse(201, checkIn()));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user, { appointment: "appt-1" });
    await user.selectOptions(screen.getByLabelText(STRENGTH), "High-security seal (H)");
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    await screen.findByText("ABC1234 is checked in.");
    expect(h.fetchStub.callsTo(`POST ${YB}/visits`)[0]?.body).toEqual({ ...CHECK_IN_BODY, trailers: [{ ...CHECK_IN_BODY.trailers[0], sealClass: "H" }] });
  });

  it("clearing the seal number takes the strength with it", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, jsonResponse(201, checkIn()));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await user.selectOptions(screen.getByLabelText(STRENGTH), "S");
    await user.clear(screen.getByLabelText("Seal number 1 (optional)"));
    expect(screen.queryByLabelText(STRENGTH)).not.toBeInTheDocument();
    // A seal typed afterwards starts with no strength stated: the old choice does not come back by itself.
    await user.type(screen.getByLabelText("Seal number 1 (optional)"), "S-200");
    expect(screen.getByLabelText(STRENGTH)).toHaveValue("");
    await user.clear(screen.getByLabelText("Seal number 1 (optional)"));
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    await screen.findByText("ABC1234 is checked in.");
    const sent = h.fetchStub.callsTo(`POST ${YB}/visits`)[0]?.body as { trailers: Record<string, unknown>[] };
    expect(sent.trailers).toEqual([{ unitNumber: "TRL-4471", kind: "DRY_VAN", loadState: "LOADED" }]);
  });

  it("seal-class-too-low: the form keeps the truck, the clerk states the strength and the second request carries it under a new key", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, (call) =>
      (call.body as { trailers: { sealClass?: string }[] }).trailers[0]?.sealClass === "H"
        ? jsonResponse(201, checkIn())
        : yardProblem(409, "seal-class-too-low", "The seal class is below the minimum of the site", "seal class is too low: the site requires class H and the seal has no class"),
    );
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user, { appointment: "appt-1" });
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("this trailer's seal is weaker or its strength was not stated");
    expect(alert).toHaveTextContent("choose it and check in again");
    expect(alert.textContent).not.toMatch(/class H|requires|usecases|\{|409/);
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("abc1234");

    await user.selectOptions(screen.getByLabelText(STRENGTH), "H");
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    expect(await screen.findByText("ABC1234 is checked in.")).toBeInTheDocument();
    const calls = h.fetchStub.callsTo(`POST ${YB}/visits`);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ trailers: [{ sealNumber: "S-100", sealClass: "H" }] });
    expect(JSON.stringify(calls[0]?.body)).not.toContain("sealClass");
    expect(calls[1]?.headers["idempotency-key"]).not.toBe(calls[0]?.headers["idempotency-key"]);
  });

  it("invalid-seal-class is explained in operator words", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, yardProblem(422, "invalid-seal-class", "The seal class is invalid", 'invalid seal class: "X" is not one of I, S or H'));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await user.selectOptions(screen.getByLabelText(STRENGTH), "I");
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The system did not accept the seal strength that was sent.");
    expect(alert).toHaveTextContent("Choose the seal strength again");
    expect(alert.textContent).not.toMatch(/"X"|is not one of|The seal class is invalid|422/);
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("abc1234");
  });
});

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

  // yard-management ADR 0016: under the REJECT policy the service records the REJECTED visit and THEN answers
  // 409 `carrier-suspended`. Checking in again would record a second turn-away, so the screen ends the truck:
  // nothing typed is left to send, and the next truck starts with one explicit tap.
  it("a suspended carrier ends the truck: turned away and on record, nothing left to submit, one tap for the next truck", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, SUSPENDED());
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This carrier is suspended, so the truck is turned away. The turn-away is already recorded.");
    expect(alert).toHaveTextContent("The truck does not enter. Tell the driver.");
    expect(alert.textContent).not.toMatch(/try again|keeps happening|vis-0a1b|SCAC|usecases|\{|409/i);
    expect(screen.getByRole("heading", { name: "ABC1234 is turned away" })).toBeInTheDocument();
    expect(screen.queryByText("Where the driver goes")).not.toBeInTheDocument();

    // The truck's data is gone from the screen: no form, no submit button, and the message cannot be dismissed away.
    expect(screen.queryByRole("button", { name: "Check in this truck" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tractor plate")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Seal number 1 (optional)")).not.toBeInTheDocument();
    expect(within(alert).queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    await user.keyboard("{Enter}");

    // Looking at another job and coming back does not bring the form back either.
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByRole("heading", { name: "ABC1234 is turned away" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check in" }));
    expect(screen.queryByRole("button", { name: "Check in this truck" })).not.toBeInTheDocument();
    expect(h.fetchStub.callsTo(`POST ${YB}/visits`)).toHaveLength(1);

    // One explicit action starts the next truck, on an empty form.
    await user.click(screen.getByRole("button", { name: "Start the next truck" }));
    expect(screen.queryByRole("heading", { name: "ABC1234 is turned away" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("");
    expect(screen.getByLabelText("Carrier")).toHaveValue("");
    expect(screen.getByLabelText("Purpose")).toHaveValue("");
    expect(screen.queryByLabelText("Kind of trailer 1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check in this truck" })).toBeEnabled();
    expect(h.fetchStub.callsTo(`POST ${YB}/visits`)).toHaveLength(1);
  });

  it("a suspended carrier answered on a replay, on the same page: the form that was still filled is gone, and the command is never sent again", async () => {
    const h = atGate(createHarness({ online: false }));
    h.fetchStub.on(`POST ${YB}/visits`, SUSPENDED());
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    expect(await screen.findByText(/Your check-in is saved on this device/)).toBeInTheDocument();
    // Saved, not answered: the form still holds the truck (a second tap would reuse the saved key).
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("abc1234");
    const key = h.outbox.list()[0]?.key;

    h.connectivity.setBrowserOnline(true);
    window.dispatchEvent(new Event("online"));
    expect(await screen.findByRole("heading", { name: "ABC1234 is turned away" })).toBeInTheDocument();
    // One message, the yard's: the station flow must not add its generic "Try again" for a command that is not its own.
    expect(screen.getByRole("alert")).toHaveTextContent("The turn-away is already recorded.");
    expect(screen.queryByText(/Try again/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/saved on this device/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check in this truck" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tractor plate")).not.toBeInTheDocument();

    // Done with its answer: out of the outbox, and later replays have nothing to send.
    expect(h.outbox.list()).toHaveLength(0);
    await h.services.runner.flush();
    window.dispatchEvent(new Event("online"));
    await h.services.runner.flush();
    const sent = h.fetchStub.callsTo(`POST ${YB}/visits`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["idempotency-key"]).toBe(key);

    await user.click(screen.getByRole("button", { name: "Start the next truck" }));
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("");
  });

  it("a suspended carrier answered on a replay after a reload shows the same turned-away state", async () => {
    const h = atGate(createHarness({ online: false }));
    const user = userEvent.setup({ delay: null });
    const first = renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    await screen.findByText(/Your check-in is saved on this device/);
    const key = h.outbox.list()[0]?.key;
    first.unmount();

    const h2 = createHarness({ store: h.store });
    h2.fetchStub.on(`POST ${YB}/visits`, SUSPENDED());
    renderApp(h2, "/yard/gate");
    expect(await screen.findByRole("heading", { name: "ABC1234 is turned away" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This carrier is suspended, so the truck is turned away.");
    expect(screen.queryByText(/Try again/i)).not.toBeInTheDocument();
    expect(h2.outbox.list()).toHaveLength(0);
    await h2.services.runner.flush();
    const sent = h2.fetchStub.callsTo(`POST ${YB}/visits`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["idempotency-key"]).toBe(key);
    // The reload emptied the form, so that truck is not in it: nothing to take away, the next truck can be typed.
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Start the next truck" })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("heading", { name: "ABC1234 is turned away" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check in this truck" })).toBeEnabled();
  });

  // The clerk does not wait for the network: truck A is saved, truck B is being typed when A's answer arrives.
  it("a turn-away answered on a replay for an EARLIER truck is announced without touching the truck being typed, which is then sent once", async () => {
    const h = atGate(createHarness({ online: false }));
    h.fetchStub.on(`POST ${YB}/visits`, (call) => ((call.body as { tractorPlate: string }).tractorPlate === "ABC1234" ? SUSPENDED() : jsonResponse(201, checkIn({ visit: visit({ tractorPlate: "XYZ9" }) }))));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    await screen.findByText(/Your check-in is saved on this device/);
    // Truck B, typed over A and not sent.
    for (const [label, text] of [["Carrier", "Good Haulage"], ["Carrier code (optional)", "good"], ["Tractor plate", "xyz9"]] as const) {
      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), text);
    }
    await user.clear(screen.getByLabelText("Seal number 1 (optional)"));
    await user.type(screen.getByLabelText("Seal number 1 (optional)"), "S-777");
    await user.selectOptions(screen.getByLabelText("Seal strength 1 (optional)"), "H");

    h.connectivity.setBrowserOnline(true);
    window.dispatchEvent(new Event("online"));
    expect(await screen.findByRole("heading", { name: "ABC1234 is turned away" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The turn-away is already recorded.");
    expect(screen.queryByText(/saved on this device/)).not.toBeInTheDocument();

    // B is untouched and still the clerk's to send.
    expect(screen.getByLabelText("Carrier")).toHaveValue("Good Haulage");
    expect(screen.getByLabelText("Carrier code (optional)")).toHaveValue("good");
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("xyz9");
    expect(screen.getByLabelText("Kind of trailer 1")).toHaveValue("DRY_VAN");
    expect(screen.getByLabelText("Seal number 1 (optional)")).toHaveValue("S-777");
    expect(screen.getByLabelText("Seal strength 1 (optional)")).toHaveValue("H");
    expect(screen.queryByRole("button", { name: "Start the next truck" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    expect(await screen.findByText("XYZ9 is checked in.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ABC1234 is turned away" })).toBeInTheDocument(); // still announced until dismissed
    const plates = h.fetchStub.callsTo(`POST ${YB}/visits`).map((c) => (c.body as { tractorPlate: string }).tractorPlate);
    expect(plates).toEqual(["ABC1234", "XYZ9"]);
    expect(h.fetchStub.callsTo(`POST ${YB}/visits`)[1]?.body).toMatchObject({ carrier: "Good Haulage", carrierScac: "GOOD", trailers: [{ sealNumber: "S-777", sealClass: "H" }] });
    expect(h.outbox.list()).toHaveLength(0);
  });

  it("a replayed turn-away for a truck with the same plate at another site does not take the form either", async () => {
    const h = atGate(createHarness({ online: false }));
    h.outbox.put({ key: "k-other", kind: "yard-check-in", method: "POST", path: `${YB}/visits`, body: { siteId: "WH2", carrier: "Acme", tractorPlate: "ABC1234", purpose: "BOBTAIL" }, dedupeId: "yard-check-in:WH2:ABC1234", meta: { siteId: "WH2", tractorPlate: "ABC1234" }, createdAt: 1, attempts: 1 });
    h.fetchStub.on(`POST ${YB}/visits`, SUSPENDED());
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.type(screen.getByLabelText("Tractor plate"), "abc1234");
    h.connectivity.setBrowserOnline(true);
    window.dispatchEvent(new Event("online"));
    expect(await screen.findByRole("heading", { name: "ABC1234 is turned away" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("abc1234");
  });

  it("two saved check-ins of suspended carriers answered one after another: both trucks are named, each was sent once", async () => {
    const h = atGate(createHarness({ online: false }));
    h.fetchStub.on(`POST ${YB}/visits`, SUSPENDED());
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    await screen.findByText(/Your check-in is saved on this device/);
    // Still offline, the next truck is typed over the first.
    await user.clear(screen.getByLabelText("Tractor plate"));
    await user.type(screen.getByLabelText("Tractor plate"), "xyz9");
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    await waitFor(() => expect(h.outbox.list()).toHaveLength(2));

    h.connectivity.setBrowserOnline(true);
    window.dispatchEvent(new Event("online"));
    expect(await screen.findByRole("heading", { name: "Turned away: ABC1234, XYZ9" })).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(h.outbox.list()).toHaveLength(0);
    await h.services.runner.flush();
    expect(h.fetchStub.callsTo(`POST ${YB}/visits`).map((c) => (c.body as { tractorPlate: string }).tractorPlate)).toEqual(["ABC1234", "XYZ9"]);
    await user.click(screen.getByRole("button", { name: "Start the next truck" }));
    expect(screen.getByLabelText("Tractor plate")).toHaveValue("");
  });

  it("any yard refusal answered on a replay is said once, in the yard's words", async () => {
    const h = atGate(createHarness({ online: false }));
    const user = userEvent.setup({ delay: null });
    const first = renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    await screen.findByText(/Your check-in is saved on this device/);
    first.unmount();

    const h2 = createHarness({ store: h.store });
    h2.fetchStub.on(`POST ${YB}/visits`, yardProblem(409, "placement-rule-violated", "A placement rule is violated"));
    renderApp(h2, "/yard/gate");
    expect(await screen.findByText(/it may only stand on a spot set aside for that/)).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("A placement rule is violated.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Try again/i)).not.toBeInTheDocument();
  });

  it("another refusal is not terminal: the form keeps the truck and can be sent again", async () => {
    const h = atGate();
    h.fetchStub.on(`POST ${YB}/visits`, yardProblem(409, "visit-already-open", "A visit is already open"));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user);
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This tractor plate is already checked in.");
    expect(screen.queryByRole("button", { name: "Start the next truck" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check in this truck" })).toBeEnabled();
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

  // The Visit schema lets `rejectionReason` carry CARRIER_SUSPENDED (yard-management ADR 0016) and, with a
  // newer service, a value this build predates. Either way the clerk reads words, never `undefined`.
  it.each([
    ["CARRIER_SUSPENDED", "Turned away: The carrier is suspended."],
    ["DRIVER_NOT_ON_LIST", "Turned away: reason DRIVER_NOT_ON_LIST."],
  ])("a REJECTED visit with reason %s is shown as turned away, in words", async (rejectionReason, text) => {
    const h = atGate();
    const rejected = checkIn({ visit: visit({ state: "REJECTED", rejectionReason }), trailers: [], moves: [] });
    h.fetchStub.on(`POST ${YB}/visits`, jsonResponse(201, rejected));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await fillCheckIn(user, { appointment: "appt-1" });
    await user.click(screen.getByRole("button", { name: "Check in this truck" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert.textContent).not.toMatch(/undefined/);
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

describe("withTurnAway", () => {
  const message = { tone: "warning" as const, what: "w", todo: "t" };
  it("names each turned-away plate once, oldest first, and adds nothing for a command that carried no plate", () => {
    const one = withTurnAway(null, "AAA1", message, false);
    expect(one.tractorPlates).toEqual(["AAA1"]);
    expect(withTurnAway(withTurnAway(one, "BBB2", message, false), "AAA1", message, false).tractorPlates).toEqual(["BBB2", "AAA1"]);
    expect(withTurnAway(null, "", message, false).tractorPlates).toEqual([]);
    expect(withTurnAway(one, "", message, false).tractorPlates).toEqual(["AAA1"]);
  });

  it("takes the form away once the truck in it was turned away, and keeps it away for later announcements", () => {
    expect(withTurnAway(null, "AAA1", message, false).blocking).toBe(false);
    const blocked = withTurnAway(withTurnAway(null, "AAA1", message, false), "BBB2", message, true);
    expect(blocked.blocking).toBe(true);
    expect(withTurnAway(blocked, "CCC3", message, false).blocking).toBe(true);
  });

  it("titles the card for no plate, one plate and several", () => {
    expect(turnAwayTitle([])).toBe("This truck is turned away");
    expect(turnAwayTitle(["AAA1"])).toBe("AAA1 is turned away");
    expect(turnAwayTitle(["AAA1", "BBB2"])).toBe("Turned away: AAA1, BBB2");
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

  it("offers only the reasons POST /visit-rejections accepts: CARRIER_SUSPENDED is the service's to set", async () => {
    const user = userEvent.setup({ delay: null });
    renderApp(atGate(), "/yard/gate");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    const offered = within(screen.getByLabelText("Reason")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(offered).toEqual(["", "APPOINTMENT_REQUIRED", "UNKNOWN_APPOINTMENT", "SEAL_MISMATCH", "TRAILER_ALREADY_ON_SITE", "SITE_REQUEST"]);
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
