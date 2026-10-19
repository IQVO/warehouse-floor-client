import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, PICK_TASK, renderApp, seedStation, STATION } from "../../test/renderApp";
import { jsonResponse, problemResponse } from "../../test/fetchStub";

const B = "/api/fulfillment-execution";

describe("station screen", () => {
  it("happy path: register, check in by scanning a badge, pull a PICK task and land on the task screen", async () => {
    const h = createHarness();
    h.fetchStub
      .on(`POST ${B}/stations`, jsonResponse(201, { id: "station-1", capabilities: ["pick"], occupied: false }))
      .on(`POST ${B}/stations/station-1/check-in`, jsonResponse(200, { id: "station-1", capabilities: ["pick"], occupied: true }))
      .on(`POST ${B}/stations/station-1/claim-next`, jsonResponse(200, PICK_TASK, { Date: "Thu, 01 Jan 2026 12:00:00 GMT" }));
    const user = userEvent.setup();
    renderApp(h);

    await user.type(screen.getByLabelText("Station ID"), "station-1");
    await user.click(screen.getByRole("button", { name: "Register station" }));
    expect(await screen.findByText("Station station-1 is registered.")).toBeInTheDocument();
    expect(h.fetchStub.calls[0]?.body).toEqual({ stationId: "station-1", capabilities: ["pick"] });

    await user.type(await screen.findByLabelText("Scan your badge"), "worker-42{Enter}");
    expect(await screen.findByText("Checked in as worker-42.")).toBeInTheDocument();
    expect(h.fetchStub.callsTo(`POST ${B}/stations/station-1/check-in`)[0]?.body).toEqual({ occupantId: "worker-42" });

    await user.click(await screen.findByRole("button", { name: "Pick" }));
    // The claim moved us to the task screen, which shows the claimed task and its lease.
    expect(await screen.findByRole("heading", { name: /PICK task/ })).toBeInTheDocument();
    expect(screen.getByText("order-42")).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("5:00");
    expect(h.fetchStub.callsTo(`POST ${B}/stations/station-1/claim-next`)[0]?.body).toEqual({ taskType: "PICK" });

    // Every command carried its own Idempotency-Key; all three differ.
    const keys = h.fetchStub.calls.map((c) => c.headers["idempotency-key"]);
    expect(keys.every((k) => typeof k === "string" && k.length > 8)).toBe(true);
    expect(new Set(keys).size).toBe(3);
  });

  it("problem path: a 422 on register is explained in plain words, never as raw JSON", async () => {
    const h = createHarness();
    h.fetchStub.on(
      `POST ${B}/stations`,
      problemResponse(422, "station-location-not-workcenter", "Station's locationCode does not resolve to a facility-layout WorkCenter", "usecases: station location does not resolve to a WorkCenter"),
    );
    const user = userEvent.setup();
    renderApp(h);
    await user.type(screen.getByLabelText("Station ID"), "station-1");
    await user.type(screen.getByLabelText("Location code (optional)"), "WH1-STOR-AMB-A07-01-01-A");
    await user.click(screen.getByRole("button", { name: "Register station" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That location is not a work center.");
    expect(alert).toHaveTextContent("Scan a work-center location label");
    expect(alert.textContent).not.toMatch(/usecases|\{|problem\+json|422/);
  });

  it("no work: claim-next 409 no-claimable-task is a calm 'nothing waiting' message and the operator stays put", async () => {
    const h = createHarness();
    seedStation(h.store, { station: STATION, occupantId: "worker-42" });
    h.fetchStub.on(`POST ${B}/stations/station-1/claim-next`, problemResponse(409, "no-claimable-task", "No claimable task for station capabilities", "usecases: no claimable task for station capabilities"));
    const user = userEvent.setup();
    renderApp(h);
    await user.click(screen.getByRole("button", { name: "Pick" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("No work is waiting for this station right now.");
    expect(status).toHaveTextContent("Nothing is wrong");
    expect(screen.getByRole("button", { name: "Pick" })).toBeEnabled();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("problem path: claim-next 404 station-not-found tells the operator to register again", async () => {
    const h = createHarness();
    seedStation(h.store, { station: STATION, occupantId: "worker-42" });
    h.fetchStub.on(`POST ${B}/stations/station-1/claim-next`, problemResponse(404, "station-not-found", "Station not found"));
    const user = userEvent.setup();
    renderApp(h);
    await user.click(screen.getByRole("button", { name: "Relocate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Register the station again");
  });

  it("problem path: check-in on an occupied station says who to ask, not 'HTTP 409'", async () => {
    const h = createHarness();
    seedStation(h.store, { station: { ...STATION, occupied: false } });
    h.fetchStub.on(`POST ${B}/stations/station-1/check-in`, problemResponse(409, "station-occupied", "Station is already occupied", "station: already occupied"));
    const user = userEvent.setup();
    renderApp(h);
    await user.type(screen.getByLabelText("Scan your badge"), "worker-7{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone is already checked in at this station.");
    expect(screen.getByLabelText("Scan your badge")).toBeInTheDocument();
  });

  it("check-out happy path returns to the check-in step; check-out is blocked while a task is held", async () => {
    const h = createHarness();
    seedStation(h.store, { station: STATION, occupantId: "worker-42" });
    h.fetchStub.on(`POST ${B}/stations/station-1/check-out`, jsonResponse(200, { id: "station-1", capabilities: ["pick"], occupied: false }));
    const user = userEvent.setup();
    renderApp(h);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    expect(await screen.findByText("Checked out.")).toBeInTheDocument();
    expect(await screen.findByLabelText("Scan your badge")).toBeInTheDocument();
    expect(h.fetchStub.callsTo(`POST ${B}/stations/station-1/check-out`)[0]?.body).toBeUndefined();
  });

  it("problem path: check-out 409 station-not-occupied resyncs the screen", async () => {
    const h = createHarness();
    seedStation(h.store, { station: STATION, occupantId: "worker-42" });
    h.fetchStub.on(`POST ${B}/stations/station-1/check-out`, problemResponse(409, "station-not-occupied", "Station is not occupied", "station: not occupied"));
    const user = userEvent.setup();
    renderApp(h);
    await user.click(screen.getByRole("button", { name: "Check out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nobody is checked in at this station.");
    expect(await screen.findByLabelText("Scan your badge")).toBeInTheDocument();
  });

  it("while a task is held, pulling is replaced by a link to it and check-out is disabled", () => {
    const h = createHarness();
    seedStation(h.store, {
      station: STATION,
      occupantId: "worker-42",
      held: { task: PICK_TASK, leaseDurationMs: 300_000, leaseExpiresAt: Date.now() + 300_000 },
    });
    renderApp(h);
    expect(screen.getByRole("link", { name: "Go to the task" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check out" })).toBeDisabled();
  });

  it("offline: a check-in scan is saved and replayed with the SAME key on reconnect", async () => {
    const h = createHarness({ online: false });
    seedStation(h.store, { station: { ...STATION, occupied: false } });
    h.fetchStub.on(`POST ${B}/stations/station-1/check-in`, jsonResponse(200, { id: "station-1", capabilities: ["pick"], occupied: true }));
    const user = userEvent.setup();
    renderApp(h);
    window.dispatchEvent(new Event("offline"));
    expect(await screen.findByText("You are offline")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Scan your badge"), "worker-42{Enter}");
    expect(await screen.findByText(/Your check-in is saved on this device/)).toBeInTheDocument();
    expect(h.fetchStub.calls).toHaveLength(0);
    expect(h.outbox.list()).toHaveLength(1);
    const savedKey = h.outbox.list()[0]?.key;

    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(h.fetchStub.calls).toHaveLength(1));
    expect(h.fetchStub.calls[0]?.headers["idempotency-key"]).toBe(savedKey);
    expect(await screen.findByText("Checked in as worker-42.")).toBeInTheDocument();
    await waitFor(() => expect(h.outbox.list()).toHaveLength(0));
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByText("Station")).toBeInTheDocument();
  });
});
