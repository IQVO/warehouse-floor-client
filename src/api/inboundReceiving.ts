import type { CommandRunner, Outcome } from "../lib/commands";
import { parseProblem, type Problem } from "../lib/problem";

/**
 * inbound-receiving, as far as the receiving-dock flow needs it. Shapes and
 * error slugs are taken from the service's apis/openapi.yaml (see
 * docs/docs/ecosystem/api-contract.md).
 *
 * Network rule: the page's own origin, path /api/inbound-receiving/..., which
 * Kong routes. Never a service URL, never a port, never another host.
 */
export const RECEIVING_BASE = "/api/inbound-receiving";

export type ScanKind = "SSCC" | "CASE_GTIN" | "EACH_GTIN";

export interface ReceiptLine {
  lineNo: number;
  sku: string;
  expectedQty: number;
  receivedGood: number;
  receivedDamaged: number;
}

/** A discrepancy found at close (Short / Over / Damaged), per line. */
export interface CloseDiscrepancy {
  lineNo: number;
  sku: string;
  kind: "Short" | "Over" | "Damaged";
  expectedQty: number;
  receivedQty: number;
  damagedQty: number;
}

export interface Receipt {
  receiptId: string;
  asnNumber: string;
  appointmentId?: string;
  doorCode?: string;
  state: "Open" | "Closed";
  lines: ReceiptLine[];
  openedAt: string;
  closedAt?: string;
  discrepancies: CloseDiscrepancy[];
  version: number;
}

export interface ReceiptPage {
  items: Receipt[];
  nextCursor?: string;
}

export interface ReceiptCartonContent {
  lineNo: number;
  sku: string;
  gtin: string;
  /** Eaches. */
  qty: number;
  lot?: string;
  expiry?: string;
  condition: "Good" | "Damaged";
}

export interface ReceiptCarton {
  /** The SSCC, or an internal `LPN-<ulid>` for a carton received without one. */
  lpn: string;
  sscc?: string;
  parentSscc?: string;
  kind: "HOMOGENEOUS_CASE" | "MIXED";
  status: "Expected" | "Accepted";
  sealed: boolean;
  contents: ReceiptCartonContent[];
  receivedAt?: string;
}

/** All nine kinds of the OpenAPI `CartonDiscrepancyKind`. */
export const CARTON_DISCREPANCY_KINDS = [
  "UnexpectedCarton",
  "MissingCarton",
  "DuplicateSscc",
  "UnknownGtin",
  "CaseQtyMismatch",
  "MixedCaseDeclaredAsCasePack",
  "UnlabelledCarton",
  "CartonOverLimit",
  "MixedCartonContentMismatch",
] as const;
export type CartonDiscrepancyKind = (typeof CARTON_DISCREPANCY_KINDS)[number];

export interface CartonDiscrepancy {
  kind: CartonDiscrepancyKind | (string & {});
  sscc?: string;
  expected?: string;
  actual?: string;
}

/** ScanResult: every quantity in eaches, computed by the server. 201 = accepted, 200 = refused with findings. */
export interface ScanResult {
  kind: ScanKind;
  accepted: boolean;
  lines: ReceiptLine[];
  cartons: ReceiptCarton[];
  discrepancies: CartonDiscrepancy[];
  version: number;
}

export interface CartonLabel {
  lpn: string;
  symbology: "CODE128";
  humanReadable: string;
  sku?: string;
  units: number;
  receivedAt: string;
}

/** The scan fields of ReceiveScanRequest this client sends (names exactly as in the spec). */
export interface ScanRequest {
  kind: ScanKind;
  id: string;
  /** Cases for CASE_GTIN, eaches for EACH_GTIN. Never multiplied here. Omitted for an SSCC. */
  qty?: number;
  lot?: string;
  expiry?: string;
  /** MIXED carton audit, SSCC scans only. */
  countedContents?: { sku: string; qty: number }[];
}

const seg = encodeURIComponent;

/** Command builders; each returns the typed outcome of one user action. */
export function inboundReceivingApi(runner: CommandRunner) {
  return {
    /**
     * One physical scan. `scanId` makes the dedupe id unique, so two scans of
     * the same case count twice; a scan saved offline or whose answer was lost
     * is replayed with ITS key (the service answers a replay with the original
     * response, so it is booked once).
     */
    receiveScan(receiptId: string, scanId: string, scan: ScanRequest): Promise<Outcome<ScanResult>> {
      return runner.submit<ScanResult>({
        kind: "receive-scan",
        path: `${RECEIVING_BASE}/receipts/${seg(receiptId)}/scans`,
        body: scan,
        dedupeId: `receive-scan:${receiptId}:${scanId}`,
        meta: { receiptId, kind: scan.kind },
      });
    },

    /** 200 + the closed receipt. One logical action per receipt, so a re-tap or a reload reuses the key. */
    closeReceipt(receiptId: string): Promise<Outcome<Receipt>> {
      return runner.submit<Receipt>({
        kind: "close-receipt",
        path: `${RECEIVING_BASE}/receipts/${seg(receiptId)}/closures`,
        dedupeId: `close-receipt:${receiptId}`,
        meta: { receiptId },
      });
    },
  };
}

export type InboundReceivingApi = ReturnType<typeof inboundReceivingApi>;

export type ReadResult<T> =
  | { state: "done"; data: T }
  | { state: "problem"; problem: Problem }
  | { state: "unreachable" };

/**
 * A plain GET (reads are not commands: no key, no outbox, nothing to replay).
 * Failures never throw: the screen shows the problem or the unreachable note.
 */
export async function getJson<T>(path: string, fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<ReadResult<T>> {
  let response: Response;
  try {
    response = await fetchFn(path, { method: "GET", headers: { Accept: "application/json, application/problem+json" } });
  } catch {
    return { state: "unreachable" };
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) return { state: "problem", problem: parseProblem(response.status, response.statusText, text) };
  try {
    return { state: "done", data: JSON.parse(text) as T };
  } catch {
    return { state: "problem", problem: parseProblem(502, "Bad Gateway", text) };
  }
}

/** Pages followed for the open-receipts list (50 each): a bound, so a misbehaving server cannot loop the screen forever. */
export const OPEN_RECEIPTS_MAX_PAGES = 20;

/** Every open receipt: follows `nextCursor` until it is absent (STANDARD 5.2), up to OPEN_RECEIPTS_MAX_PAGES. */
export async function listOpenReceipts(fetchFn?: typeof fetch): Promise<ReadResult<ReceiptPage>> {
  const items: Receipt[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < OPEN_RECEIPTS_MAX_PAGES; page++) {
    const query = `state=Open&limit=50${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const result = await getJson<ReceiptPage>(`${RECEIVING_BASE}/receipts?${query}`, fetchFn);
    if (result.state !== "done") return result;
    items.push(...result.data.items);
    cursor = result.data.nextCursor;
    if (cursor === undefined || cursor === "") return { state: "done", data: { items } };
  }
  return { state: "done", data: { items, nextCursor: cursor } };
}

export const receivingReads = {
  getReceipt: (receiptId: string, fetchFn?: typeof fetch) =>
    getJson<Receipt>(`${RECEIVING_BASE}/receipts/${seg(receiptId)}`, fetchFn),
  listOpenReceipts: (fetchFn?: typeof fetch) => listOpenReceipts(fetchFn),
  getCartonLabel: (receiptId: string, lpn: string, fetchFn?: typeof fetch) =>
    getJson<CartonLabel>(`${RECEIVING_BASE}/receipts/${seg(receiptId)}/cartons/${seg(lpn)}/label`, fetchFn),
};
