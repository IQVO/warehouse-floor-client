import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { YARD_PREFS_KEY } from "./yardPrefs";
import { createHarness, renderApp, type Harness } from "../../test/renderApp";
import { jsonResponse } from "../../test/fetchStub";
import { YB, move, trailer, yardProblem } from "../../test/yardFixtures";

vi.setConfig({ testTimeout: 30_000 });

const TRAILERS = `GET ${YB}/trailers?siteId=WH1&limit=500`;
const MOVES = `GET ${YB}/moves?siteId=WH1&state=CLAIMED&limit=500`;

const AT_DOOR_1 = trailer({
  trailerId: "trl-1",
  unitNumber: "TRL-4471",
  state: "DOCKED",
  location: { kind: "DOOR", code: "WH1-DOCK-IN-01" },
  doorWork: "WAITING",
  asnNumbers: ["ASN-1001"],
  openMoveId: null,
});
const AT_DOOR_2 = trailer({
  trailerId: "trl-2",
  unitNumber: "TRL-9",
  state: "DOCKED",
  location: { kind: "DOOR", code: "WH1-DOCK-OUT-01" },
  doorWork: "IN_PROGRESS",
  outboundRef: "SHIP-7",
  loadState: "EMPTY",
  openMoveId: null,
});
const ARRIVING = trailer({ trailerId: "trl-3", unitNumber: "TRL-33", state: "IN_MOVE", location: null, openMoveId: "mv-3" });
const VISITING = move({ moveId: "mv-3", trailerId: "trl-3", to: { kind: "DOOR", code: "WH1-DOCK-IN-02" }, reason: "TO_DOOR" });

function wedge(label: string, code: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: code } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function atDock(h = createHarness(), trailers = [AT_DOOR_2, AT_DOOR_1, ARRIVING], moves = [VISITING]): Harness {
  h.store.setItem(YARD_PREFS_KEY, JSON.stringify({ siteId: "WH1", hostlerRef: "" }));
  h.fetchStub.on(TRAILERS, jsonResponse(200, { items: trailers }));
  h.fetchStub.on(MOVES, jsonResponse(200, { items: moves }));
  return h;
}

describe("dock operator: trailers at doors", () => {
  it("lists the docked trailers by door, with their door-work step", async () => {
    const h = atDock();
    renderApp(h, "/yard/dock");
    const first = await screen.findByRole("heading", { name: "Door WH1-DOCK-IN-01: TRL-4471" });
    const second = screen.getByRole("heading", { name: "Door WH1-DOCK-OUT-01: TRL-9" });
    // sorted by door code: IN-01 before OUT-01 even though the service listed OUT first
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("ASN-1001")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /TRL-33/ })).not.toBeInTheDocument(); // still on the move: not at a door
    expect(h.fetchStub.calls.every((c) => c.url.startsWith(`${YB}/`) && c.method === "GET")).toBe(true);
  });

  it("starts door work: POST with a key, no body, and the card moves on to the next step", async () => {
    const h = atDock();
    h.fetchStub.on(`POST ${YB}/trailers/trl-1/door-work-starts`, jsonResponse(200, { ...AT_DOOR_1, doorWork: "IN_PROGRESS", version: 2 }));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/dock");
    await user.click(await screen.findByRole("button", { name: "Start door work on TRL-4471" }));
    expect(await screen.findByText("Door work started on TRL-4471.")).toBeInTheDocument();
    const [call] = h.fetchStub.callsTo(`POST ${YB}/trailers/trl-1/door-work-starts`);
    expect(call?.headers["idempotency-key"]).toBeTruthy();
    expect(call?.body).toBeUndefined();
    expect(screen.getByRole("button", { name: "Complete door work on TRL-4471" })).toBeInTheDocument();
  });

  it("completes door work with the load state: an inbound unload suggests EMPTY, an outbound LOADED, and it can be changed", async () => {
    const h = atDock(createHarness(), [{ ...AT_DOOR_1, doorWork: "IN_PROGRESS" }, { ...AT_DOOR_2, loadState: "EMPTY" }]);
    h.fetchStub.on(`POST ${YB}/trailers/trl-1/door-work-completions`, jsonResponse(200, { ...AT_DOOR_1, doorWork: "DONE", loadState: "EMPTY", version: 3 }));
    h.fetchStub.on(`POST ${YB}/trailers/trl-2/door-work-completions`, jsonResponse(200, { ...AT_DOOR_2, doorWork: "DONE", loadState: "PARTIAL", version: 3 }));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/dock");
    const inbound = await screen.findByLabelText("Load state when finished (TRL-4471)");
    const outbound = screen.getByLabelText("Load state when finished (TRL-9)");
    expect(inbound).toHaveValue("EMPTY");
    expect(outbound).toHaveValue("LOADED");

    await user.click(screen.getByRole("button", { name: "Complete door work on TRL-4471" }));
    expect(await screen.findByText("Door work done on TRL-4471.")).toBeInTheDocument();
    expect(h.fetchStub.callsTo(`POST ${YB}/trailers/trl-1/door-work-completions`)[0]?.body).toEqual({ loadState: "EMPTY" });

    await user.selectOptions(screen.getByLabelText("Load state when finished (TRL-9)"), "PARTIAL");
    await user.click(screen.getByRole("button", { name: "Complete door work on TRL-9" }));
    await screen.findByText("Door work done on TRL-9.");
    expect(h.fetchStub.callsTo(`POST ${YB}/trailers/trl-2/door-work-completions`)[0]?.body).toEqual({ loadState: "PARTIAL" });
    expect(screen.queryByRole("button", { name: /door work on/ })).not.toBeInTheDocument();
  });

  it("with no suggestion the load state is left to the service (empty body)", async () => {
    const t = { ...AT_DOOR_2, outboundRef: null, asnNumbers: [] };
    const h = atDock(createHarness(), [t]);
    h.fetchStub.on(`POST ${YB}/trailers/trl-2/door-work-completions`, jsonResponse(200, { ...t, doorWork: "DONE", version: 2 }));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/dock");
    await user.click(await screen.findByRole("button", { name: "Complete door work on TRL-9" }));
    await screen.findByText("Door work done on TRL-9.");
    expect(h.fetchStub.callsTo(`POST ${YB}/trailers/trl-2/door-work-completions`)[0]?.body).toEqual({});
  });

  it("scanning a door (or a unit number) shows that trailer only; a stranger code is explained", async () => {
    const h = atDock();
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/dock");
    await screen.findByRole("heading", { name: /TRL-4471/ });
    wedge("Scan a door or a trailer", "WH1-DOCK-OUT-01");
    expect(await screen.findByRole("heading", { name: /TRL-9/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /TRL-4471/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all doors" }));
    expect(screen.getByRole("heading", { name: /TRL-4471/ })).toBeInTheDocument();

    await new Promise((r) => setTimeout(r, 450));
    wedge("Scan a door or a trailer", "trl-4471");
    await screen.findByRole("button", { name: "Show all doors" });
    expect(screen.queryByRole("heading", { name: /TRL-9/ })).not.toBeInTheDocument();

    await new Promise((r) => setTimeout(r, 450));
    wedge("Scan a door or a trailer", "WH1-DOCK-IN-99");
    expect(await screen.findByRole("alert")).toHaveTextContent("No trailer is docked at, or numbered, WH1-DOCK-IN-99.");
    await new Promise((r) => setTimeout(r, 450));
    wedge("Scan a door or a trailer", "03041090004827");
    expect(await screen.findByText(/product or carton barcode/)).toBeInTheDocument();
  });

  it("a trailer on hold cannot start work, and says why", async () => {
    const h = atDock(createHarness(), [{ ...AT_DOOR_1, hold: "SEAL_BROKEN" }], []);
    renderApp(h, "/yard/dock");
    expect(await screen.findByText(/On hold \(seal broken\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start door work on TRL-4471" })).toBeDisabled();
  });

  it("problem path: trailer-on-hold from the service is explained, never raw", async () => {
    const h = atDock();
    h.fetchStub.on(`POST ${YB}/trailers/trl-1/door-work-starts`, yardProblem(409, "trailer-on-hold", "Trailer is on hold", "usecases: trailer on hold"));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/dock");
    await user.click(await screen.findByRole("button", { name: "Start door work on TRL-4471" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This trailer is on hold, so door work cannot start.");
    expect(alert.textContent).not.toMatch(/usecases|409|\{/);
  });

  it("offline: door work is saved, a second tap reuses the key, and a reload replays it", async () => {
    const h = atDock(createHarness({ online: false }));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/dock");
    await user.click(await screen.findByRole("button", { name: "Start door work on TRL-4471" }));
    expect(await screen.findByText(/Your door work is saved on this device/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start door work on TRL-4471" }));
    expect(h.outbox.list()).toHaveLength(1);
    const key = h.outbox.list()[0]?.key;

    const h2 = atDock(createHarness({ store: h.store }));
    h2.fetchStub.on(`POST ${YB}/trailers/trl-1/door-work-starts`, jsonResponse(200, { ...AT_DOOR_1, doorWork: "IN_PROGRESS", version: 2 }));
    renderApp(h2, "/yard/dock");
    expect(await screen.findByText("Door work started on TRL-4471.")).toBeInTheDocument();
    expect(h2.fetchStub.callsTo(`POST ${YB}/trailers/trl-1/door-work-starts`)[0]?.headers["idempotency-key"]).toBe(key);
  });

  it("says so when the yard cannot be read, and asks for a site first", async () => {
    const h = createHarness();
    h.store.setItem(YARD_PREFS_KEY, JSON.stringify({ siteId: "WH1", hostlerRef: "" }));
    h.fetchStub.on(TRAILERS, yardProblem(500, "internal-error", "Internal"));
    h.fetchStub.on(MOVES, jsonResponse(200, { items: [] }));
    renderApp(h, "/yard/dock");
    expect(await screen.findByRole("alert")).toHaveTextContent("The server hit an unexpected error.");

    const bare = createHarness();
    renderApp(bare, "/yard/dock");
    expect(await screen.findAllByText("Enter the site code first.")).not.toHaveLength(0);
  });
});

describe("dock operator: a driver bringing their own trailer", () => {
  it("lists the claimed visiting-driver moves and completes one without hostlerRef", async () => {
    const h = atDock();
    h.fetchStub.on(`POST ${YB}/moves/mv-3/completions`, jsonResponse(200, { ...VISITING, state: "COMPLETED", actualLocation: VISITING.to }));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/dock");
    const list = (await screen.findByText("Drivers bringing their own trailer")).closest("section") ?? document.body;
    await user.click(within(list).getByRole("button", { name: "TRL-33" }));
    expect(screen.getByText("Confirm the arrival")).toBeInTheDocument();
    wedge("Scan the spot or door where the trailer is", "WH1-DOCK-IN-02");
    await user.click(await screen.findByRole("button", { name: "Complete move" }));

    expect(await screen.findByText("The trailer is at WH1-DOCK-IN-02.")).toBeInTheDocument();
    const [call] = h.fetchStub.callsTo(`POST ${YB}/moves/mv-3/completions`);
    expect(call?.body).toEqual({ actualLocation: { kind: "DOOR", code: "WH1-DOCK-IN-02" } });
    expect(call?.headers["idempotency-key"]).toBeTruthy();
    // the lists were read again
    expect(h.fetchStub.callsTo(TRAILERS).length).toBe(2);
  });

  it("a different door needs a reason and goes with its kind", async () => {
    const h = atDock();
    h.fetchStub.on(`POST ${YB}/moves/mv-3/completions`, jsonResponse(200, { ...VISITING, state: "COMPLETED" }));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/dock");
    await user.click(await screen.findByRole("button", { name: "TRL-33" }));
    wedge("Scan the spot or door where the trailer is", "WH1-DOCK-IN-03");
    await user.click(await screen.findByLabelText("A door"));
    await user.type(screen.getByLabelText("Why is it not at the planned place?"), "door 2 jammed");
    await user.click(screen.getByRole("button", { name: "Complete move" }));
    await screen.findByText(/The trailer is at/);
    expect(h.fetchStub.callsTo(`POST ${YB}/moves/mv-3/completions`)[0]?.body).toEqual({
      actualLocation: { kind: "DOOR", code: "WH1-DOCK-IN-03" },
      deviationNote: "door 2 jammed",
    });
  });

  it("problem path: a door that is closed or taken is explained and the move stays", async () => {
    const h = atDock();
    h.fetchStub.on(`POST ${YB}/moves/mv-3/completions`, yardProblem(409, "location-occupied", "Occupied"));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/dock");
    await user.click(await screen.findByRole("button", { name: "TRL-33" }));
    wedge("Scan the spot or door where the trailer is", "WH1-DOCK-IN-02");
    await user.click(await screen.findByRole("button", { name: "Complete move" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That place already holds a trailer.");
    expect(screen.getByText("Confirm the arrival")).toBeInTheDocument();
  });

  it("with no driver on the way it says so", async () => {
    const h = atDock(createHarness(), [AT_DOOR_1], []);
    renderApp(h, "/yard/dock");
    expect(await screen.findByText("No driver is on the way to a place.")).toBeInTheDocument();
  });
});
