import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HOSTLER_KEY, leaseDeadline, loadHeld } from "./hostlerState";
import { YARD_PREFS_KEY } from "./yardPrefs";
import { createHarness, renderApp, type Harness } from "../../test/renderApp";
import { jsonResponse } from "../../test/fetchStub";
import { YB, move, trailer, yardProblem } from "../../test/yardFixtures";

vi.setConfig({ testTimeout: 30_000 });

const CLAIMS = `POST ${YB}/moves/claims`;
const COMPLETE = `POST ${YB}/moves/mv-9/completions`;
const MINE = `GET ${YB}/moves?siteId=WH1&state=CLAIMED&limit=500`;
const NOW = "Fri, 06 Nov 2026 12:00:00 GMT";
const CLAIMED = move({
  moveId: "mv-9",
  performer: "HOSTLER",
  hostlerRef: "host-1",
  from: { kind: "SPOT", code: "WH1-YARD-01" },
  to: { kind: "SPOT", code: "WH1-YARD-02" },
  reason: "RELOCATE",
  priority: { band: 3, dueBy: "2026-11-06T15:30:00Z" },
  leaseExpiresAt: "2026-11-06T12:05:00Z",
});

function wedge(code: string) {
  const input = screen.getByLabelText("Scan the spot or door where the trailer is");
  fireEvent.change(input, { target: { value: code } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function asHostler(h = createHarness()): Harness {
  h.store.setItem(YARD_PREFS_KEY, JSON.stringify({ siteId: "WH1", hostlerRef: "host-1" }));
  h.fetchStub.on(MINE, jsonResponse(200, { items: [] }));
  h.fetchStub.on(`GET ${YB}/trailers/trl-1`, jsonResponse(200, trailer({ unitNumber: "TRL-4471" })));
  return h;
}

async function claim(h: Harness, user: ReturnType<typeof userEvent.setup>) {
  h.fetchStub.on(CLAIMS, jsonResponse(201, CLAIMED, { Date: NOW }));
  renderApp(h, "/yard/hostler");
  await user.click(screen.getByRole("button", { name: "Claim next move" }));
  await screen.findByText("Your move");
}

describe("hostler", () => {
  it("claims the next move: the system picks it, and from / to / why / due and the lease are shown", async () => {
    const h = asHostler();
    const user = userEvent.setup({ delay: null });
    await claim(h, user);

    const [call] = h.fetchStub.callsTo(CLAIMS);
    expect(call?.body).toEqual({ siteId: "WH1", hostlerRef: "host-1" });
    expect(call?.headers["idempotency-key"]).toBeTruthy();
    const facts = screen.getByText("From").closest("dl");
    expect(facts).toHaveTextContent("Spot WH1-YARD-01");
    expect(facts).toHaveTextContent("Spot WH1-YARD-02");
    expect(facts).toHaveTextContent("relocate");
    expect(facts?.textContent).toMatch(/Due\d{1,2}:\d{2}/);
    expect(await screen.findByText("TRL-4471")).toBeInTheDocument();
    // 12:05 lease expiry minus the response's own 12:00 clock.
    expect(screen.getByRole("timer")).toHaveTextContent("5:00");
    expect(screen.getByText(/It cannot be extended/)).toBeInTheDocument();
  });

  it("completes with the scanned place: planned place sends no deviation note", async () => {
    const h = asHostler();
    h.fetchStub.on(COMPLETE, jsonResponse(200, { ...CLAIMED, state: "COMPLETED", actualLocation: CLAIMED.to }));
    const user = userEvent.setup({ delay: null });
    await claim(h, user);
    wedge("WH1-YARD-02");
    expect(await screen.findByText("At the planned place: Spot WH1-YARD-02.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Complete move" }));

    expect(await screen.findByText("Move done. The trailer is at WH1-YARD-02.")).toBeInTheDocument();
    const [done] = h.fetchStub.callsTo(COMPLETE);
    expect(done?.body).toEqual({ hostlerRef: "host-1", actualLocation: { kind: "SPOT", code: "WH1-YARD-02" } });
    expect(done?.headers["idempotency-key"]).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claim next move" })).toBeInTheDocument();
    expect(h.store.getItem(HOSTLER_KEY)).toBeNull();
  });

  it("another place needs a reason and its kind; both go in the request", async () => {
    const h = asHostler();
    h.fetchStub.on(COMPLETE, jsonResponse(200, { ...CLAIMED, state: "COMPLETED" }));
    const user = userEvent.setup({ delay: null });
    await claim(h, user);
    wedge("WH1-DOCK-OUT-02");
    expect(await screen.findByText("Not the planned place. You scanned WH1-DOCK-OUT-02.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Complete move" });
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText("A door"));
    await user.type(screen.getByLabelText("Why is it not at the planned place?"), "  spot taken  ");
    expect(button).toBeEnabled();
    await user.click(button);
    await screen.findByText(/Move done/);
    expect(h.fetchStub.callsTo(COMPLETE)[0]?.body).toEqual({
      hostlerRef: "host-1",
      actualLocation: { kind: "DOOR", code: "WH1-DOCK-OUT-02" },
      deviationNote: "spot taken",
    });
  });

  it("a carton barcode scanned as the place is refused and nothing is sent", async () => {
    const h = asHostler();
    const user = userEvent.setup({ delay: null });
    await claim(h, user);
    wedge("340123450000000017");
    expect(await screen.findByRole("alert")).toHaveTextContent("That is a product or carton barcode, not a spot or door label.");
    expect(screen.queryByRole("button", { name: "Complete move" })).not.toBeInTheDocument();
    expect(h.fetchStub.callsTo(COMPLETE)).toHaveLength(0);
  });

  it("problem path: a taken place is explained and the move stays in hand", async () => {
    const h = asHostler();
    h.fetchStub.on(COMPLETE, yardProblem(409, "location-occupied", "The location already holds a trailer", "usecases: location is occupied"));
    const user = userEvent.setup({ delay: null });
    await claim(h, user);
    wedge("WH1-YARD-02");
    await user.click(await screen.findByRole("button", { name: "Complete move" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That place already holds a trailer.");
    expect(alert.textContent).not.toMatch(/usecases|409|\{/);
    expect(screen.getByText("Your move")).toBeInTheDocument();
  });

  it("problem path: after the lease ran out the answer drops the move and offers the next claim", async () => {
    const h = asHostler();
    h.fetchStub.on(COMPLETE, yardProblem(409, "not-lease-holder", "Not the lease holder"));
    const user = userEvent.setup({ delay: null });
    await claim(h, user);
    wedge("WH1-YARD-02");
    await user.click(await screen.findByRole("button", { name: "Complete move" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You no longer hold this move");
    expect(await screen.findByRole("button", { name: "Claim next move" })).toBeInTheDocument();
    expect(h.store.getItem(HOSTLER_KEY)).toBeNull();
  });

  it("nothing waiting is a calm message; a missing hostler id is caught before sending", async () => {
    const h = asHostler();
    h.fetchStub.on(CLAIMS, yardProblem(404, "no-claimable-move", "No claimable move"));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/hostler");
    await user.click(screen.getByRole("button", { name: "Claim next move" }));
    expect(await screen.findByRole("status")).toHaveTextContent("No move is waiting for you right now.");

    await user.clear(screen.getByLabelText("Your hostler id"));
    await user.click(screen.getByRole("button", { name: "Claim next move" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the site code and your hostler id first.");
    expect(h.fetchStub.callsTo(CLAIMS)).toHaveLength(1);
  });

  it("hostler-busy tells the hostler they already hold a move", async () => {
    const h = asHostler();
    h.fetchStub.on(CLAIMS, yardProblem(409, "hostler-busy", "Hostler busy"));
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/hostler");
    await user.click(screen.getByRole("button", { name: "Claim next move" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You already hold a move.");
  });

  it("a reload keeps the held move; the service is asked and agrees", async () => {
    const h = asHostler();
    const user = userEvent.setup({ delay: null });
    await claim(h, user);
    const h2 = createHarness({ store: h.store });
    h2.fetchStub.on(MINE, jsonResponse(200, { items: [CLAIMED] }));
    h2.fetchStub.on(`GET ${YB}/trailers/trl-1`, jsonResponse(200, trailer({ unitNumber: "TRL-4471" })));
    renderApp(h2, "/yard/hostler");
    expect(await screen.findAllByText("Your move")).not.toHaveLength(0);
    expect(screen.getAllByText(/Spot WH1-YARD-02/).length).toBeGreaterThan(0);
    await waitFor(() => expect(h2.fetchStub.callsTo(MINE)).toHaveLength(1));
  });

  it("a reload with no held move adopts the one the service says is claimed (the claim answer was lost)", async () => {
    const h = asHostler();
    h.fetchStub.on(MINE, jsonResponse(200, { items: [move({ moveId: "mv-x", performer: "VISITING_DRIVER" }), CLAIMED] }));
    renderApp(h, "/yard/hostler");
    expect(await screen.findByText("Your move")).toBeInTheDocument();
    expect(h.fetchStub.callsTo(CLAIMS)).toHaveLength(0);
  });

  it("a held move the service no longer lists as claimed is dropped, with a note", async () => {
    const h = asHostler();
    h.store.setItem(HOSTLER_KEY, JSON.stringify({ move: CLAIMED, leaseDeadline: Date.now() + 60_000 }));
    renderApp(h, "/yard/hostler");
    expect(await screen.findByText(/it went back to the queue or was finished/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim next move" })).toBeInTheDocument();
  });

  it("a run-out lease says so instead of a calm countdown", async () => {
    const h = asHostler();
    h.store.setItem(HOSTLER_KEY, JSON.stringify({ move: CLAIMED, leaseDeadline: Date.now() - 5000 }));
    h.fetchStub.on(MINE, jsonResponse(200, { items: [CLAIMED] }));
    renderApp(h, "/yard/hostler");
    expect(await screen.findByText(/Your time has run out/)).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("0:00");
  });

  it("no end time from the service shows a dash, not a zero", async () => {
    const h = asHostler();
    h.store.setItem(HOSTLER_KEY, JSON.stringify({ move: { ...CLAIMED, leaseExpiresAt: null }, leaseDeadline: null }));
    h.fetchStub.on(MINE, jsonResponse(200, { items: [{ ...CLAIMED, leaseExpiresAt: null }] }));
    renderApp(h, "/yard/hostler");
    expect(await screen.findByText(/gave no end time/)).toBeInTheDocument();
  });

  it("offline: the completion is saved, tapped again with the same key, and replayed after a reload", async () => {
    const h = asHostler();
    const user = userEvent.setup({ delay: null });
    await claim(h, user);
    h.connectivity.setBrowserOnline(false);
    wedge("WH1-YARD-02");
    await user.click(await screen.findByRole("button", { name: "Complete move" }));
    expect(await screen.findByText(/Your move completion is saved on this device/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Complete move" }));
    expect(h.outbox.list()).toHaveLength(1);
    const key = h.outbox.list()[0]?.key;

    const h2 = createHarness({ store: h.store });
    h2.fetchStub.on(MINE, jsonResponse(200, { items: [CLAIMED] }));
    h2.fetchStub.on(`GET ${YB}/trailers/trl-1`, jsonResponse(200, trailer()));
    h2.fetchStub.on(COMPLETE, jsonResponse(200, { ...CLAIMED, state: "COMPLETED", actualLocation: CLAIMED.to }));
    renderApp(h2, "/yard/hostler");
    expect(await screen.findByText("Move done. The trailer is at WH1-YARD-02.")).toBeInTheDocument();
    expect(h2.fetchStub.callsTo(COMPLETE)[0]?.headers["idempotency-key"]).toBe(key);
  });
});

describe("hostler state helpers", () => {
  it("leaseDeadline is expiry minus the service clock, on the local clock", () => {
    expect(leaseDeadline("2026-11-06T12:05:00Z", Date.parse("2026-11-06T12:00:00Z"), 1000)).toBe(1000 + 300_000);
    expect(leaseDeadline("2026-11-06T12:05:00Z", undefined, Date.parse("2026-11-06T12:01:00Z"))).toBe(Date.parse("2026-11-06T12:05:00Z"));
    expect(leaseDeadline(null, 1, 2)).toBeNull();
    expect(leaseDeadline("not a date", 1, 2)).toBeNull();
  });

  it("loadHeld ignores damaged storage", () => {
    const h = createHarness();
    expect(loadHeld(h.store)).toBeNull();
    h.store.setItem(HOSTLER_KEY, "{not json");
    expect(loadHeld(h.store)).toBeNull();
    h.store.setItem(HOSTLER_KEY, JSON.stringify({ move: { moveId: 3 } }));
    expect(loadHeld(h.store)).toBeNull();
    h.store.setItem(HOSTLER_KEY, "null");
    expect(loadHeld(h.store)).toBeNull();
  });
});
