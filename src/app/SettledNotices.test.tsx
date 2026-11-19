import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { describeProblem } from "../api/problemMessages";
import type { ScanResult } from "../api/inboundReceiving";
import type { OutboxEntry } from "../lib/outbox";
import { jsonResponse, problemResponse } from "../test/fetchStub";
import { createHarness, renderApp, type Harness } from "../test/renderApp";
import { YB, checkIn, move, visit, yardProblem } from "../test/yardFixtures";
import { addSettledNotice } from "./settledFallback";

vi.setConfig({ testTimeout: 30_000 });

const RB = "/api/inbound-receiving";
const FE = "/api/fulfillment-execution";
const VISITS = `POST ${YB}/visits`;
const SCANS = `POST ${RB}/receipts/rcpt-1/scans`;
const COMPLETE = `POST ${FE}/tasks/t-1/completions`;

/** What a page that was closed, or a connection that dropped, left in the outbox. */
const CHECK_IN: OutboxEntry = {
  key: "k-yard", kind: "yard-check-in", method: "POST", path: `${YB}/visits`, dedupeId: "yard-check-in:WH1:ABC1234", meta: { siteId: "WH1", tractorPlate: "ABC1234" }, createdAt: 1, attempts: 1,
  body: { siteId: "WH1", carrier: "Acme Freight", carrierScac: "ACME", tractorPlate: "ABC1234", purpose: "BOBTAIL" },
};
const SCAN: OutboxEntry = {
  key: "k-scan", kind: "receive-scan", method: "POST", path: `${RB}/receipts/rcpt-1/scans`, dedupeId: "receive-scan:rcpt-1:s-1", meta: { receiptId: "rcpt-1", kind: "SSCC" }, createdAt: 1, attempts: 1,
  body: { kind: "SSCC", id: "340123450000000017" },
};
const FE_COMPLETE: OutboxEntry = {
  key: "k-fe", kind: "complete", method: "POST", path: `${FE}/tasks/t-1/completions`, dedupeId: "complete:t-1", meta: { taskId: "t-1", stationId: "station-1" }, createdAt: 1, attempts: 1,
  body: { stationId: "station-1" },
};
const SUSPENDED = () => yardProblem(409, "carrier-suspended", "The carrier is suspended", "the carrier is suspended: SCAC ACME is suspended; visit vis-0a1b is recorded as REJECTED");
const SUSPENDED_WHAT = "Saved check-in (truck ABC1234): This carrier is suspended, so the truck is turned away. The turn-away is already recorded.";
const receipt = (receiptId: string) => ({ receiptId, asnNumber: `ASN-${receiptId}`, doorCode: "WH1-DOCK-IN-01", state: "Open", lines: [], openedAt: "2026-10-24T08:00:00Z", discrepancies: [], version: 1 });

function withQueued(entry: OutboxEntry, answerKey: string, answer: Response): Harness {
  const h = createHarness();
  h.outbox.put(entry);
  h.fetchStub.on(answerKey, answer);
  return h;
}
/** The replay ran and its entry is finished. */
const settled = (h: Harness) => waitFor(() => expect(h.outbox.list()).toHaveLength(0));
const alerts = () => screen.getAllByRole("alert");
/** The notice that says `what` (the "sending saved actions" banner is an alert too while the replay runs). */
const noticeSaying = async (what: string) => (await screen.findByText(what)).closest("div") as HTMLElement;

describe("a replayed command is answered exactly once, whichever screen is in view", () => {
  it("(a) yard check-in turned away while the operator is on the station screen: one global notice, the yard's words, the truck named", async () => {
    const h = withQueued(CHECK_IN, VISITS, SUSPENDED());
    renderApp(h, "/");
    const alert = await noticeSaying(SUSPENDED_WHAT);
    await settled(h);
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("The truck does not enter. Tell the driver. Nothing more to enter: do not check it in again or use Reject.");
    expect(alerts()).toHaveLength(1);
    expect(screen.queryByText(/Try again/i)).not.toBeInTheDocument();
    expect(alert.textContent).not.toMatch(/vis-0a1b|SCAC|usecases|\{|409/);
    // Sent once with its saved key, and never again.
    await h.services.runner.flush();
    expect(h.fetchStub.callsTo(VISITS).map((c) => c.headers["idempotency-key"])).toEqual(["k-yard"]);
    // It stays until the operator dismisses it, also across screens.
    const user = userEvent.setup({ delay: null });
    await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByText("Receiving"));
    expect(screen.getByText(SUSPENDED_WHAT)).toBeInTheDocument();
    await user.click(within(await noticeSaying(SUSPENDED_WHAT)).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(SUSPENDED_WHAT)).not.toBeInTheDocument();
  });

  it("(a) the same when the operator walked from the gate to the station screen before the connection came back", async () => {
    const h = createHarness({ online: false });
    h.outbox.put(CHECK_IN);
    h.fetchStub.on(VISITS, SUSPENDED());
    const user = userEvent.setup({ delay: null });
    renderApp(h, "/yard/gate");
    await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByText("Station"));
    h.connectivity.setBrowserOnline(true);
    window.dispatchEvent(new Event("online"));
    expect(await screen.findByText(SUSPENDED_WHAT)).toBeInTheDocument();
    await settled(h);
    expect(alerts()).toHaveLength(1);
    expect(screen.queryByText(/Try again/i)).not.toBeInTheDocument();
  });

  it("(a) a yard screen that does not own the command is not its screen: on the hostler screen the global notice speaks", async () => {
    const h = withQueued(CHECK_IN, VISITS, yardProblem(409, "no-free-spot", "No free spot"));
    renderApp(h, "/yard/hostler");
    expect(await screen.findByText("Saved check-in (truck ABC1234): There is no free parking spot in the yard right now.")).toBeInTheDocument();
    await settled(h);
    expect(alerts()).toHaveLength(1);
  });

  it("(b) the same answer while the gate screen is in view: the turned-away card only, the global bar silent", async () => {
    const h = withQueued(CHECK_IN, VISITS, SUSPENDED());
    renderApp(h, "/yard/gate");
    expect(await screen.findByRole("heading", { name: "ABC1234 is turned away" })).toBeInTheDocument();
    await settled(h);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toHaveTextContent("This carrier is suspended, so the truck is turned away. The turn-away is already recorded.");
    expect(screen.queryByText(/Saved check-in/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Try again/i)).not.toBeInTheDocument();
  });

  it("(c) receiving scan refused while another receipt is open: one global notice in receiving's words, naming the receipt", async () => {
    const h = withQueued(SCAN, SCANS, problemResponse(422, "invalid-sscc", "Invalid SSCC"));
    h.fetchStub.on(`GET ${RB}/receipts/rcpt-2`, jsonResponse(200, receipt("rcpt-2")));
    renderApp(h, "/receiving/rcpt-2");
    await screen.findByText("ASN-rcpt-2");
    const alert = await noticeSaying("Saved scan (receipt rcpt-1): That carton label (SSCC) was misread or is not valid.");
    await settled(h);
    expect(alert).toHaveTextContent("Scan the carton label again.");
    expect(alerts()).toHaveLength(1);
    expect(screen.queryByText(/Invalid SSCC|Try again/)).not.toBeInTheDocument();
  });

  it("(c) receiving scan refused while the operator is on another screen: the same one global notice", async () => {
    const h = withQueued(SCAN, SCANS, problemResponse(422, "invalid-sscc", "Invalid SSCC"));
    renderApp(h, "/yard/gate");
    expect(await screen.findByText("Saved scan (receipt rcpt-1): That carton label (SSCC) was misread or is not valid.")).toBeInTheDocument();
    await settled(h);
    expect(alerts()).toHaveLength(1);
    await h.services.runner.flush();
    expect(h.fetchStub.callsTo(SCANS)).toHaveLength(1);
  });

  it("(d) receiving scan refused while its own receipt is open: the screen says it, once, as before", async () => {
    const h = withQueued(SCAN, SCANS, problemResponse(422, "invalid-sscc", "Invalid SSCC"));
    h.fetchStub.on(`GET ${RB}/receipts/rcpt-1`, jsonResponse(200, receipt("rcpt-1")));
    renderApp(h, "/receiving/rcpt-1");
    expect(await screen.findByText("That carton label (SSCC) was misread or is not valid.")).toBeInTheDocument();
    await settled(h);
    expect(alerts()).toHaveLength(1);
    expect(screen.queryByText(/Saved scan/)).not.toBeInTheDocument();
  });

  it("(e) a fulfillment command is answered by the station flow as before, on any screen, and not a second time", async () => {
    const refusal = { type: `https://errors.fulfillment-execution.warehouse-systems.dev/station-not-found`, title: "Station not found", status: 404 };
    const h = withQueued(FE_COMPLETE, COMPLETE, problemResponse(404, "station-not-found", "Station not found"));
    renderApp(h, "/yard/gate");
    const alert = await noticeSaying(describeProblem(refusal).what);
    await settled(h);
    expect(alert).toHaveTextContent(describeProblem(refusal).todo);
    expect(alerts()).toHaveLength(1);
    expect(screen.queryByText(/Saved /)).not.toBeInTheDocument();
  });
});

describe("answers that need the operator although they are not refusals", () => {
  it("a replayed check-in that went through off screen says where the driver goes", async () => {
    const h = withQueued(CHECK_IN, VISITS, jsonResponse(201, checkIn()));
    renderApp(h, "/");
    expect(await screen.findByText("Saved check-in: ABC1234 is checked in.")).toBeInTheDocument();
    expect(screen.getByText("Tell the driver: take TRL-4471 to Door WH1-DOCK-IN-01 (to a door).")).toBeInTheDocument();
    await settled(h);
  });

  it("a replayed check-in answered with a REJECTED visit off screen is a turn-away in words", async () => {
    const h = withQueued(CHECK_IN, VISITS, jsonResponse(201, checkIn({ visit: visit({ state: "REJECTED", rejectionReason: "SEAL_MISMATCH" }), trailers: [], moves: [] })));
    renderApp(h, "/");
    const alert = await noticeSaying("Saved check-in (truck ABC1234): Turned away: The seal does not match.");
    expect(alert).toHaveTextContent("The truck does not enter. Tell the driver.");
  });

  it("a replayed scan the service did not book off screen says what was found and what to do", async () => {
    const refused: ScanResult = { kind: "SSCC", accepted: false, lines: [], cartons: [], discrepancies: [{ kind: "DuplicateSscc", sscc: "340123450000000017" }], version: 3 };
    const h = withQueued(SCAN, SCANS, jsonResponse(200, refused));
    renderApp(h, "/");
    const alert = await noticeSaying("Saved scan (receipt rcpt-1): This carton was already received. Nothing was booked for that scan.");
    expect(alert).toHaveTextContent("Do not count it again.");
  });

  it("a replayed claim that went through off screen says a move is held; plain confirmations stay quiet", async () => {
    const h = createHarness();
    h.outbox.put({ ...CHECK_IN, key: "k-claim", kind: "yard-claim", path: `${YB}/moves/claims`, dedupeId: "yard-claim:WH1:host-1", meta: { siteId: "WH1", hostlerRef: "host-1" }, body: { siteId: "WH1", hostlerRef: "host-1" } });
    h.outbox.put({ ...SCAN, key: "k-ok" });
    h.fetchStub.on(`POST ${YB}/moves/claims`, jsonResponse(201, move({ performer: "HOSTLER" })));
    h.fetchStub.on(SCANS, jsonResponse(201, { kind: "SSCC", accepted: true, lines: [], cartons: [], discrepancies: [], version: 2 }));
    renderApp(h, "/");
    expect(await screen.findByText("Saved claim: a move is yours.")).toBeInTheDocument();
    await settled(h);
    expect(screen.queryByText(/Saved scan/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("two refusals one after another are both kept: the second does not replace the first", async () => {
    const h = createHarness();
    h.outbox.put(CHECK_IN);
    h.outbox.put(SCAN);
    h.fetchStub.on(VISITS, SUSPENDED());
    h.fetchStub.on(SCANS, problemResponse(422, "invalid-sscc", "Invalid SSCC"));
    renderApp(h, "/");
    expect(await screen.findByText(SUSPENDED_WHAT)).toBeInTheDocument();
    expect(await screen.findByText("Saved scan (receipt rcpt-1): That carton label (SSCC) was misread or is not valid.")).toBeInTheDocument();
    expect(alerts()).toHaveLength(2);
  });
});

describe("addSettledNotice", () => {
  const m = { tone: "warning" as const, what: "w", todo: "t" };
  it("keeps every different message and counts a repeated one instead of stacking it", () => {
    const one = addSettledNotice([], m);
    expect(one).toMatchObject([{ what: "w", times: 1 }]);
    const two = addSettledNotice(addSettledNotice(one, { ...m, what: "other" }), m);
    expect(two.map((n) => [n.what, n.times])).toEqual([["w", 2], ["other", 1]]);
    expect(new Set(two.map((n) => n.id)).size).toBe(2);
  });
});
