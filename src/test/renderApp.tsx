import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppProviders, AppRoutes } from "../App";
import { createServices, type Services } from "../app/servicesContext";
import { StationProvider } from "../features/station/StationProvider";
import { STORAGE_KEY, type HeldTask } from "../features/station/stationState";
import type { Station, Task } from "../api/fulfillmentExecution";
import { CommandRunner } from "../lib/commands";
import { Connectivity } from "../lib/connectivity";
import { Outbox } from "../lib/outbox";
import { MemoryStore } from "../lib/storage";
import { createFetchStub } from "./fetchStub";

export const STATION: Station = { id: "station-1", capabilities: ["pick"], occupied: true };

export const PICK_TASK: Task = {
  id: "20260101T120000.000000000",
  type: "PICK",
  status: "CLAIMED",
  cpt: "2026-01-01T18:00:00Z",
  orderRef: "order-42",
  requiredCapabilities: ["pick"],
  fragile: false,
  leaseStationId: "station-1",
  leaseExpiry: "2026-01-01T12:05:00Z",
};

export interface Harness {
  services: Services;
  store: MemoryStore;
  outbox: Outbox;
  connectivity: Connectivity;
  fetchStub: ReturnType<typeof createFetchStub>;
}

/** A fresh services set whose runner talks to a fetch stub; `store` may be reused to simulate a page reload. */
export function createHarness(options: { store?: MemoryStore; online?: boolean; fetchStub?: ReturnType<typeof createFetchStub> } = {}): Harness {
  const store = options.store ?? new MemoryStore();
  const outbox = new Outbox(store);
  const connectivity = new Connectivity(options.online ?? true);
  const fetchStub = options.fetchStub ?? createFetchStub();
  let n = 0;
  const runner = new CommandRunner({
    outbox,
    connectivity,
    fetchFn: () => fetchStub as unknown as typeof fetch,
    newKey: () => `key-${++n}-${Math.random().toString(36).slice(2, 8)}`,
    // Tests drive replays explicitly (or through the online event); keep the interval out of the way.
    retryIntervalMs: 3_600_000,
  });
  return { services: createServices({ store, outbox, connectivity, runner }), store, outbox, connectivity, fetchStub };
}

/** Pre-load what a previous page load would have persisted. */
export function seedStation(store: MemoryStore, state: { station?: Station; occupantId?: string; held?: HeldTask }): void {
  store.setItem(
    STORAGE_KEY,
    JSON.stringify({ station: state.station ?? null, occupantId: state.occupantId ?? null, held: state.held ?? null }),
  );
}

export function renderApp(harness: Harness, route = "/") {
  return render(
    <AppProviders services={harness.services}>
      <MemoryRouter initialEntries={[route]}>
        <StationProvider>
          <AppRoutes />
        </StationProvider>
      </MemoryRouter>
    </AppProviders>,
  );
}
