import { createContext, use, useSyncExternalStore } from "react";
import { CommandRunner } from "../lib/commands";
import { Connectivity } from "../lib/connectivity";
import { Outbox, type OutboxEntry } from "../lib/outbox";
import { defaultStore, type KeyValueStore } from "../lib/storage";

/** The app's singletons, injectable so tests can run on a fresh set. */
export interface Services {
  store: KeyValueStore;
  outbox: Outbox;
  connectivity: Connectivity;
  runner: CommandRunner;
  /** Wall clock, injectable for the lease countdown. */
  now: () => number;
}

export function createServices(overrides: Partial<Services> = {}): Services {
  const store = overrides.store ?? defaultStore();
  const outbox = overrides.outbox ?? new Outbox(store);
  const connectivity = overrides.connectivity ?? new Connectivity();
  const now = overrides.now ?? Date.now;
  const runner = overrides.runner ?? new CommandRunner({ outbox, connectivity, now });
  return { store, outbox, connectivity, runner, now };
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = use(ServicesContext);
  if (services === null) throw new Error("useServices outside <ServicesProvider>");
  return services;
}

/** Whether the network is believed to work (browser flag AND last request reached the edge). */
export function useOnline(): boolean {
  const { connectivity } = useServices();
  return useSyncExternalStore(
    (listener) => connectivity.subscribe(listener),
    () => connectivity.isOnline(),
  );
}

/** Commands saved on this device and not yet answered. */
export function usePendingCommands(): readonly OutboxEntry[] {
  const { outbox } = useServices();
  return useSyncExternalStore(
    (listener) => outbox.subscribe(listener),
    () => outbox.list(),
  );
}
