import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CartonLabel, Receipt, ScanResult } from "../../api/inboundReceiving";
import { CARTON_DISCREPANCY_KINDS } from "../../api/inboundReceiving";
import { FINDING_KINDS, describeFinding } from "../../api/receivingMessages";
import { createHarness, renderApp } from "../../test/renderApp";
import { jsonResponse, problemResponse } from "../../test/fetchStub";

const B = "/api/inbound-receiving";
const RID = "rcpt-1";
const GET_RECEIPT = `GET ${B}/receipts/${RID}`;
const SCANS = `POST ${B}/receipts/${RID}/scans`;
const CLOSE = `POST ${B}/receipts/${RID}/close`;
const LABEL = (lpn: string) => `GET ${B}/receipts/${RID}/cartons/${lpn}/label`;
const SSCC = "340123450000000017";
const CASE_GTIN = "13041090004824";
const EACH_GTIN = "03041090004827";
const GS = "\u001d";

const RECEIPT: Receipt = {
  receiptId: RID,
  asnNumber: "ASN-1001",
  doorCode: "WH1-DOCK-IN-01",
  state: "Open",
  lines: [{ lineNo: 1, sku: "SKU-1", expectedQty: 40, receivedGood: 0, receivedDamaged: 0 }],
  openedAt: "2026-10-24T08:00:00Z",
  discrepancies: [],
  version: 1,
};

function scanResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    kind: "SSCC",
    accepted: true,
    lines: [{ lineNo: 1, sku: "SKU-1", expectedQty: 40, receivedGood: 20, receivedDamaged: 0 }],
    cartons: [
      {
        lpn: SSCC,
        sscc: SSCC,
        kind: "HOMOGENEOUS_CASE",
        status: "Accepted",
        sealed: true,
        contents: [{ lineNo: 1, sku: "SKU-1", gtin: EACH_GTIN, qty: 20, condition: "Good" }],
      },
    ],
    discrepancies: [],
    version: 2,
    ...over,
  };
}

function wedge(code: string) {
  const input = screen.getByLabelText("Scan now");
  fireEvent.change(input, { target: { value: code } });
  fireEvent.keyDown(input, { key: "Enter" });
}

async function open(h = createHarness()) {
  h.fetchStub.on(GET_RECEIPT, jsonResponse(200, RECEIPT));
  renderApp(h, `/receiving/${RID}`);
  await screen.findByText("ASN-1001");
  return h;
}

afterEach(() => vi.restoreAllMocks());

describe("receiving dock", () => {
  it("lists the open receipts and opens one by id", async () => {
    const h = createHarness();
    h.fetchStub.on(`GET ${B}/receipts?state=Open&limit=50`, jsonResponse(200, { items: [RECEIPT] }));
    renderApp(h, "/receiving");
    expect(await screen.findByRole("link", { name: RID })).toHaveAttribute("href", `/receiving/${RID}`);
    // No station, no task claim: nothing was asked of fulfillment-execution.
    expect(h.fetchStub.calls.every((c) => c.url.startsWith(B))).toBe(true);
  });

  it("a carton SSCC scan posts {kind, id} with its own key and shows the server's eaches", async () => {
    const h = await open();
    h.fetchStub.on(SCANS, jsonResponse(201, scanResult()));
    wedge(`]C100${SSCC}`);
    expect(await screen.findByText(/20 eaches of SKU-1/)).toBeInTheDocument();
    expect(screen.getByText("Received.")).toBeInTheDocument();
    const call = h.fetchStub.callsTo(SCANS)[0];
    expect(call?.body).toEqual({ kind: "SSCC", id: SSCC });
    expect(call?.headers["idempotency-key"]).toMatch(/\S{8,}/);
    expect(h.outbox.list()).toHaveLength(0);
    // The running table is the server's (20 of 40), not computed here.
    expect(screen.getByRole("cell", { name: "20" })).toBeInTheDocument();
  });

  it("a second scan of the same carton is its own action with a new key", async () => {
    const h = await open();
    h.fetchStub.on(SCANS, jsonResponse(201, scanResult()));
    wedge(SSCC);
    await waitFor(() => expect(h.fetchStub.callsTo(SCANS)).toHaveLength(1));
    await screen.findByText("Received.");
    await new Promise((r) => setTimeout(r, 450)); // past the scanner de-bounce
    wedge(SSCC);
    await waitFor(() => expect(h.fetchStub.callsTo(SCANS)).toHaveLength(2));
    const [a, b] = h.fetchStub.callsTo(SCANS);
    expect(a?.headers["idempotency-key"]).not.toBe(b?.headers["idempotency-key"]);
  });

  it("a case GTIN counts CASES: qty is what was typed, never multiplied", async () => {
    const h = await open();
    h.fetchStub.on(SCANS, jsonResponse(201, scanResult({ kind: "CASE_GTIN", cartons: [] })));
    await userEvent.setup().click(screen.getByRole("button", { name: "Cases" }));
    fireEvent.change(screen.getByLabelText("Cases in this scan"), { target: { value: "3" } });
    wedge(CASE_GTIN);
    await waitFor(() => expect(h.fetchStub.callsTo(SCANS)).toHaveLength(1));
    expect(h.fetchStub.callsTo(SCANS)[0]?.body).toEqual({ kind: "CASE_GTIN", id: CASE_GTIN, qty: 3 });
    await screen.findByText("Received.");
    expect(screen.getByLabelText("Cases in this scan")).toHaveValue(1);
  });

  it("an each GTIN (any printed form) posts the 14-digit id; lot and expiry from a GS1-128 label go along", async () => {
    const h = await open();
    h.fetchStub.on(SCANS, jsonResponse(201, scanResult({ kind: "EACH_GTIN", cartons: [] })));
    await userEvent.setup().click(screen.getByRole("button", { name: "Items" }));
    wedge("]E03041090004827");
    await waitFor(() => expect(h.fetchStub.callsTo(SCANS)).toHaveLength(1));
    expect(h.fetchStub.callsTo(SCANS)[0]?.body).toEqual({ kind: "EACH_GTIN", id: EACH_GTIN, qty: 1 });
    await screen.findByText("Received.");
    await new Promise((r) => setTimeout(r, 450));
    wedge(`0103041090004827${"10"}LOT7${GS}17261231`);
    await waitFor(() => expect(h.fetchStub.callsTo(SCANS)).toHaveLength(2));
    expect(h.fetchStub.callsTo(SCANS)[1]?.body).toEqual({ kind: "EACH_GTIN", id: EACH_GTIN, qty: 1, lot: "LOT7", expiry: "2026-12-31" });
  });

  it("refuses before any request: carton label in Cases mode, item barcode in Carton mode, misread barcode", async () => {
    const h = await open();
    wedge("3041090004828"); // bad check digit
    expect(await screen.findByText(/misread/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 450));
    wedge(CASE_GTIN); // Carton mode, a GTIN
    expect(await screen.findByText(/not a carton label/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Cases" }));
    await new Promise((r) => setTimeout(r, 450));
    wedge(SSCC);
    expect(await screen.findByText(/not an item or case barcode/)).toBeInTheDocument();
    expect(h.fetchStub.callsTo(SCANS)).toHaveLength(0);
  });

  it("mixed carton audit: the counted contents ride on the SSCC scan, the finding explains the difference", async () => {
    const h = await open();
    h.fetchStub.on(
      SCANS,
      jsonResponse(
        201,
        scanResult({ discrepancies: [{ kind: "MixedCartonContentMismatch", sscc: SSCC, expected: "SKU-2:5", actual: "SKU-2:4" }] }),
      ),
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("Mixed carton: count what is inside"));
    await user.click(screen.getByRole("button", { name: "Add a SKU" }));
    await user.type(screen.getByLabelText("Counted SKU 1"), "SKU-2");
    await user.type(screen.getByLabelText("Counted quantity 1"), "4");
    wedge(SSCC);
    await waitFor(() => expect(h.fetchStub.callsTo(SCANS)).toHaveLength(1));
    expect(h.fetchStub.callsTo(SCANS)[0]?.body).toEqual({ kind: "SSCC", id: SSCC, countedContents: [{ sku: "SKU-2", qty: 4 }] });
    expect(await screen.findByText("What you counted differs from the carton label")).toBeInTheDocument();
    expect(screen.getByText(/Expected: SKU-2:5/)).toBeInTheDocument();
    expect(screen.getByText(/Found: SKU-2:4/)).toBeInTheDocument();
    expect(screen.getByText(/counted quantities were received/)).toBeInTheDocument();
  });

  it("a refused scan (200 accepted=false) shows what to do and says nothing was booked", async () => {
    const h = await open();
    h.fetchStub.on(
      SCANS,
      jsonResponse(200, scanResult({ accepted: false, cartons: [], discrepancies: [{ kind: "DuplicateSscc", sscc: SSCC }] })),
    );
    wedge(SSCC);
    expect(await screen.findByText("This carton was already received")).toBeInTheDocument();
    expect(screen.getByText(/Do not count it again/)).toBeInTheDocument();
    expect(screen.getByText("Not received. Nothing was booked for that scan.")).toBeInTheDocument();
  });

  it("CartonOverLimit is accepted with a warning copy", async () => {
    const h = await open();
    h.fetchStub.on(
      SCANS,
      jsonResponse(201, scanResult({ discrepancies: [{ kind: "CartonOverLimit", sscc: SSCC, expected: "grossWeightG:25000", actual: "grossWeightG:31000" }] })),
    );
    wedge(SSCC);
    expect(await screen.findByText("This carton is heavier or longer than the limit")).toBeInTheDocument();
    expect(screen.getByText(/It was received\. Handle it with two people/)).toBeInTheDocument();
    expect(screen.getByText(/Found: grossWeightG:31000/)).toBeInTheDocument();
  });

  it("UnlabelledCarton: fetches the label data for the internal LPN and prints it", async () => {
    const lpn = "LPN-01K8Z3Q5R7T9V1W2X4Y6A8B0CD";
    const label: CartonLabel = { lpn, symbology: "CODE128", humanReadable: lpn, sku: "SKU-1", units: 20, receivedAt: "2026-10-24T08:10:00Z" };
    const h = await open();
    h.fetchStub.on(
      SCANS,
      jsonResponse(
        201,
        scanResult({
          kind: "CASE_GTIN",
          cartons: [{ lpn, kind: "HOMOGENEOUS_CASE", status: "Accepted", sealed: true, contents: [{ lineNo: 1, sku: "SKU-1", gtin: EACH_GTIN, qty: 20, condition: "Good" }] }],
          discrepancies: [{ kind: "UnlabelledCarton" }],
        }),
      ),
    );
    h.fetchStub.on(LABEL(lpn), jsonResponse(200, label));
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cases" }));
    wedge(CASE_GTIN);
    expect(await screen.findByText("This case has no carton label")).toBeInTheDocument();
    const printButton = await screen.findByRole("button", { name: "Print label" });
    expect(screen.getAllByText(lpn).length).toBeGreaterThan(0);
    await user.click(printButton);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("offline: the scan is saved with its key and replayed with that key; its answer is shown then", async () => {
    const h = await open();
    h.fetchStub.on(SCANS, jsonResponse(201, scanResult()));
    h.connectivity.setBrowserOnline(false);
    window.dispatchEvent(new Event("offline"));
    await screen.findByText("You are offline");
    wedge(SSCC);
    expect(await screen.findByText(/1 scan is saved on this device/)).toBeInTheDocument();
    const saved = h.outbox.list()[0];
    expect(saved).toMatchObject({ kind: "receive-scan", body: { kind: "SSCC", id: SSCC } });
    h.connectivity.setBrowserOnline(true);
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(h.fetchStub.callsTo(SCANS)).toHaveLength(1));
    expect(h.fetchStub.callsTo(SCANS)[0]?.headers["idempotency-key"]).toBe(saved?.key);
    expect(await screen.findByText(/20 eaches of SKU-1/)).toBeInTheDocument();
    await waitFor(() => expect(h.outbox.list()).toHaveLength(0));
  });

  it("a lost answer: the retry after a reload uses the same key", async () => {
    const first = createHarness();
    first.fetchStub.on(GET_RECEIPT, jsonResponse(200, RECEIPT));
    const view = renderApp(first, `/receiving/${RID}`);
    await screen.findByText("ASN-1001");
    first.fetchStub.on(SCANS, "network-error");
    wedge(SSCC);
    await screen.findByText(/1 scan is saved on this device/);
    const key = first.outbox.list()[0]?.key;
    view.unmount();

    const second = createHarness({ store: first.store });
    second.fetchStub.on(GET_RECEIPT, jsonResponse(200, RECEIPT));
    second.fetchStub.on(SCANS, jsonResponse(201, scanResult()));
    renderApp(second, `/receiving/${RID}`);
    await waitFor(() => expect(second.fetchStub.callsTo(SCANS)).toHaveLength(1));
    expect(second.fetchStub.callsTo(SCANS)[0]?.headers["idempotency-key"]).toBe(key);
    await waitFor(() => expect(second.outbox.list()).toHaveLength(0));
  });

  it("problem+JSON slugs map to what/what-to-do copy; the raw detail is never shown", async () => {
    const h = await open();
    h.fetchStub.on(SCANS, problemResponse(422, "counted-contents-not-mixed", "x", "usecases: engineer wording"));
    wedge(SSCC);
    expect(await screen.findByText(/audit count only applies to a mixed carton/)).toBeInTheDocument();
    expect(screen.queryByText(/engineer wording/)).not.toBeInTheDocument();
    expect(h.outbox.list()).toHaveLength(0);
  });

  it("closing shows the closed receipt's Short/Over lines; a repeat reuses the key", async () => {
    const h = await open();
    const closed: Receipt = {
      ...RECEIPT,
      state: "Closed",
      closedAt: "2026-10-24T09:00:00Z",
      discrepancies: [{ lineNo: 1, sku: "SKU-1", kind: "Short", expectedQty: 40, receivedQty: 20, damagedQty: 0 }],
    };
    h.fetchStub.on(CLOSE, jsonResponse(200, closed));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Close receipt" }));
    await user.click(screen.getByRole("button", { name: "Yes, close the receipt" }));
    expect(await screen.findByText("The receipt is closed.")).toBeInTheDocument();
    expect(screen.getByText(/SKU-1: Short \(expected 40, received 20/)).toBeInTheDocument();
    expect(h.fetchStub.callsTo(CLOSE)[0]?.headers["idempotency-key"]).toMatch(/\S{8,}/);
    expect(screen.queryByLabelText("Scan now")).not.toBeInTheDocument();
  });

  it("an unknown receipt says so", async () => {
    const h = createHarness();
    h.fetchStub.on(GET_RECEIPT, problemResponse(404, "receipt-not-found", "Not Found"));
    renderApp(h, `/receiving/${RID}`);
    expect(await screen.findByText("The system does not know that receipt.")).toBeInTheDocument();
  });
});

describe("finding copy", () => {
  it("covers all nine carton discrepancy kinds, each with a what-to-do", () => {
    expect(CARTON_DISCREPANCY_KINDS).toHaveLength(9);
    expect([...FINDING_KINDS].sort()).toEqual([...CARTON_DISCREPANCY_KINDS].sort());
    for (const kind of CARTON_DISCREPANCY_KINDS) {
      const c = describeFinding({ kind });
      expect(c.title).not.toBe("The system flagged this scan");
      expect(c.todo.length).toBeGreaterThan(10);
    }
  });
});
