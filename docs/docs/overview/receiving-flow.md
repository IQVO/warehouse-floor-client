# Receiving flow (inbound-receiving)

Source of truth: `apis/openapi.yaml` in IQVO/inbound-receiving (read from `origin/develop`). All paths are under `/api/inbound-receiving` at this app's own origin (Kong). Contract: mastercase `contracts.md` sections 1, 7 (R7), 9 (R10, R11, R13).

## Screens

1. **`/receiving`.** A receipt number field, and the open receipts (`GET /receipts?state=Open&limit=50`, first page).
2. **`/receiving/:receiptId`.** Header from `GET /receipts/{id}` (delivery notice, door, state), then *Scan to receive*, the last scan's result, the receipt's lines (Expected / Good / Damaged, in **eaches**, as the server last said) and *Close receipt* (two taps: close, then confirm).

## What the operator scans

A three-way choice sets what the next scan must be; it is sent as `kind`, so the service refuses a mismatch (`422 scan-kind-mismatch`, nothing changes).

| Choice | Scan | Request body (`POST /receipts/{id}/scans`) | Quantity |
|---|---|---|---|
| Carton | carton label, SSCC (AI 00, any `]C1` / bare 18 digits) | `{kind:"SSCC", id}` (+ `countedContents`) | the server accepts the carton's whole manifest, per sku, in eaches |
| Cases | case GTIN (any printed form, normalised to GTIN-14) | `{kind:"CASE_GTIN", id, qty}` | `qty` counts **cases** (default 1, 1..1000). The service multiplies by units per pack; the client never multiplies |
| Items | each GTIN | `{kind:"EACH_GTIN", id, qty, lot?, expiry?}` | `qty` eaches (default 1) |

The GS1 parser (`src/lib/gs1/`) only tells *what* was scanned (SSCC or a GTIN-14, lot, expiry) and rejects a misread barcode before any request. A GTIN scan in Carton mode, or an SSCC in Cases/Items mode, is refused on the device with a sentence saying which button to press. Nothing is sent for it. Lot and expiry from a GS1-128 label are sent as `lot` / `expiry` (`YYYY-MM-DD`). The count field resets to 1 after every scan.

What is shown after a scan comes from the answer (`ScanResult`): accepted or not, each carton's contents per sku **in eaches**, and the running receipt lines. The device computes no quantity.

## Mixed-carton audit (R10)

"Mixed carton: count what is inside" lets the operator add `sku` + counted quantity rows (0 allowed: looked for, found none). The rows ride on the **next SSCC scan** as `countedContents:[{sku, qty}]` and are cleared after it. The quantity received is the counted one; every sku that differs raises `MixedCartonContentMismatch` (`expected` / `actual` = `<sku>:<qty>`, shown as the service sent them). On a homogeneous carton the service answers `422 counted-contents-not-mixed` (copy below). Not used: `GET /asns/{asn}/cartons` could prefill the rows from the manifest; later work.

## Findings (the nine `CartonDiscrepancyKind`s)

A finding is not an error. A *refused* scan is `200` with `accepted:false` (nothing booked); an *accepted* scan is `201`, possibly with findings (the goods are physically here). Copy lives in `src/api/receivingMessages.ts` (`describeFinding`), and a test checks all nine kinds have copy.

| Kind | Booked? | The operator sees (what / what to do) |
|---|---|---|
| `UnexpectedCarton` | no | This carton is not on the delivery notice. / Do not put it away. Set it aside in the problem area and tell your lead. |
| `MissingCarton` | n/a (raised at close) | A carton on the delivery notice never arrived. / Nothing to do on the dock; the lead is told. |
| `DuplicateSscc` | no | This carton was already received. / Do not count it again. If it is a second carton with the same label, set it aside and tell your lead. |
| `UnknownGtin` | no | The system does not know that barcode. / Set the goods aside in the problem area and tell your lead. |
| `CaseQtyMismatch` | no | The quantity does not match the case. / Count the items in the case; a full case: scan again; otherwise scan the items one by one. |
| `MixedCaseDeclaredAsCasePack` | no | The label says one product but the case holds something else. / Open the case, set it aside, tell your lead. |
| `UnlabelledCarton` | yes | This case has no carton label. / It was given a new label number. Print the label below and stick it on the case. |
| `CartonOverLimit` | yes | This carton is heavier or longer than the limit. / Handle it with two people or a lift, and tell the receiving lead. |
| `MixedCartonContentMismatch` | yes (counted) | What you counted differs from the carton label. / The counted quantities were received; tell the lead. |

`sscc`, `expected` and `actual` of a finding are shown as the service sent them (`Carton ...`, `Expected: ...`, `Found: ...`). An unknown future kind gets a generic "set the goods aside and tell your lead".

## Unlabelled carton: label and Print (R11)

When a scan answers `UnlabelledCarton`, every carton in the answer without an `sscc` has an internal `LPN-<ulid>`; the screen fetches `GET /receipts/{id}/cartons/{lpn}/label` and shows the label data (human-readable text, sku, units, received at) with a **Print label** button. It calls `window.print()`; the print CSS in `src/styles/floor.css` hides everything but the label. The service has no printer driver.

**Barcode:** the label draws a scannable barcode as inline SVG: Code 128 (set B) for an internal `LPN-<ulid>` and GS1-128 (FNC1, AI (00) + 18 digits) for an SSCC, from a small in-app encoder (`src/lib/barcode`, no library), with quiet zones, mm-based bar widths and the human-readable text underneath. What it prints is read back through the same GS1 parser the scan flow uses (a scanner that strips the `]C1` identifier delivers the SSCC as 20 digits starting `00`, which the parser accepts). A physical scanner has not been tested against a printed label.

## Commands, keys and retries

- `receive-scan`: `dedupeId = receive-scan:<receiptId>:<scanId>` with a fresh `scanId` per physical scan, so scanning the same code twice is two actions with two keys (two cases are two cases). One scan saved offline, or whose answer was lost, is replayed with **its own** key, also after a reload. The replayed answer is shown when it arrives.
- `close-receipt`: `dedupeId = close-receipt:<receiptId>`, one logical action per receipt.
- Reads (`GET` receipt, list, label) are plain fetches: no key, no outbox. Offline, the receipt cannot be (re)loaded; scans can still be taken and are queued.
- `If-Match` is not sent: with several operators on one receipt a stale value would refuse scans for no benefit; the service serialises writes (`409 concurrent-modification`, copy: "scan again").

**inbound-receiving does de-duplicate by `Idempotency-Key`** (per its OpenAPI: a replay with the same key and body returns the original response; the same key with another body is `422 idempotency-key-reused`; a missing key is `400 idempotency-key-required` on `/scans`). This is read from the spec; it was not exercised against a live service from this repo (the stub implements the same rule). Unlike fulfillment-execution, then, a replayed scan is not booked twice, and the duplicate-SSCC finding is a second line of defence, not the only one. If a deployment turns out not to dedupe, the symptom is a `DuplicateSscc` finding on the replay for a carton, and a double count for case/each GTIN scans (no client workaround is attempted).

## Spec observations

- The OpenAPI examples use SSCC `340123450000000013`, whose GS1 check digit is wrong (the valid one is `...017`). This client rejects it before any request ("misread"); fixtures here use valid SSCCs.
- `GET /asns/{asnNumber}/cartons` exists and is unused so far.
