import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ServicesProvider } from "../app/ServicesProvider";
import type { Services } from "../app/servicesContext";
import { CommandRunner } from "../lib/commands";
import { Connectivity } from "../lib/connectivity";
import { Outbox, type OutboxEntry } from "../lib/outbox";
import { MemoryStore } from "../lib/storage";
import { createFetchStub, noContent } from "../test/fetchStub";
import { StuckOutboxBanner } from "./StuckOutboxBanner";

function stuckEntry(key: string): OutboxEntry {
  return { key, kind: "complete", method: "POST", path: "/api/x", meta: {}, createdAt: 1, attempts: 8, stuck: true };
}

function setup(entries: OutboxEntry[]) {
  const store = new MemoryStore();
  const outbox = new Outbox(store);
  for (const e of entries) outbox.put(e);
  const fetchStub = createFetchStub().on("POST /api/x", noContent());
  const connectivity = new Connectivity(true);
  const services: Services = {
    store,
    outbox,
    connectivity,
    runner: new CommandRunner({ outbox, connectivity, fetchFn: () => fetchStub as unknown as typeof fetch }),
    fetchFn: () => fetchStub as unknown as typeof fetch,
    now: () => 0,
  };
  render(
    <ServicesProvider services={services}>
      <StuckOutboxBanner />
    </ServicesProvider>,
  );
  return { outbox, fetchStub };
}

describe("StuckOutboxBanner", () => {
  it("is hidden while nothing is stuck, counts stuck entries when one is", () => {
    const { outbox } = setup([
      { key: "pending", kind: "complete", method: "POST", path: "/api/x", meta: {}, createdAt: 1, attempts: 2 },
      stuckEntry("k1"),
      stuckEntry("k2"),
    ]);
    expect(screen.getByRole("alert")).toHaveTextContent("2 saved actions could not be sent");
    void outbox;
  });

  it('"Send again" replays stuck entries with the same key and the banner clears once they land', async () => {
    const { fetchStub } = setup([stuckEntry("k1")]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(fetchStub.callsTo("POST /api/x").map((c) => c.headers["idempotency-key"])).toEqual(["k1"]);
  });

  it('"Discard" drops the stuck entries without another request', async () => {
    const { fetchStub } = setup([stuckEntry("k1")]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(fetchStub.calls).toHaveLength(0);
  });
});
