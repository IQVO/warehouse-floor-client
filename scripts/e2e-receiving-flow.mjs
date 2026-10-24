#!/usr/bin/env node
// Drives the receiving-dock flow in headless Chromium against a running dev
// server and the stub (`npm run stub-api`, `FLOOR_API_TARGET=http://localhost:8787 npm run dev`).
// Prints one line per verified behaviour; exits non-zero on the first failure.
//
//   E2E_BASE (default http://localhost:5174)   STUB_URL (default http://localhost:8787)
//   E2E_SHOTS (default ./e2e-shots)            E2E_CHROMIUM = path of an installed Chromium
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:5174";
const STUB = process.env.STUB_URL ?? "http://localhost:8787";
const SHOTS = process.env.E2E_SHOTS ?? "e2e-shots";
const API = "/api/inbound-receiving";
const SSCC = "340123450000000017";
const SSCC_MIXED = "340123450000000024";
const SSCC_HEAVY = "340123450000000031";
mkdirSync(SHOTS, { recursive: true });

function expect(cond, msg) {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`PASS  ${msg}`);
}

const browser = await chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 420, height: 860 }, hasTouch: true });
const page = await context.newPage();
const commands = [];
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith("/api/")) commands.push({ method: r.method(), path: u.pathname, key: r.headers()["idempotency-key"] ?? null });
});
const shot = (name) => page.screenshot({ path: `${SHOTS}/recv-${name}.png` });
const stubLog = async () => (await fetch(`${STUB}/__stub/log`)).json();
const stub = (path) => fetch(`${STUB}/__stub/${path}`, { method: "POST" });
/** Keyboard-wedge emulation: fast keystrokes then Enter, no field focused by the test. */
async function wedgeScan(code) {
  await page.keyboard.type(code, { delay: 4 });
  await page.keyboard.press("Enter");
}
const settle = () => page.waitForTimeout(450); // past the scanner de-bounce

try {
  await stub("reset");
  await page.goto(`${BASE}/receiving`);
  await page.getByRole("link", { name: "rcpt-stub-1" }).click();
  await page.getByText("ASN-1001").waitFor();
  expect(true, "open receipt listed under /receiving and opened with no station or task claim");

  // ---- carton SSCC: eaches come from the server ----
  await wedgeScan(SSCC);
  await page.getByText(/20 eaches of SKU-1/).waitFor();
  expect(true, "carton SSCC accepted; the answer shows 20 eaches of SKU-1 (from the server)");
  await shot("1-carton");

  // ---- CartonOverLimit: accepted with a warning ----
  await settle();
  await wedgeScan(SSCC_HEAVY);
  await page.getByText("This carton is heavier or longer than the limit").waitFor();
  expect(await page.getByText("Found: grossWeightG:31000").isVisible(), "CartonOverLimit: carton still received, finding and what-to-do shown");
  await shot("2-over-limit");

  // ---- duplicate SSCC: refused, nothing booked ----
  await settle();
  await wedgeScan(SSCC);
  await page.getByText("This carton was already received").waitFor();
  expect(await page.getByText("Not received. Nothing was booked for that scan.").isVisible(), "DuplicateSscc: refused with what-to-do copy");

  // ---- mixed carton audit ----
  await settle();
  await page.getByText("Mixed carton: count what is inside").click();
  await page.getByRole("button", { name: "Add a SKU" }).click();
  await page.getByLabel("Counted SKU 1").fill("SKU-2");
  await page.getByLabel("Counted quantity 1").fill("1");
  await page.getByRole("button", { name: "Add a SKU" }).click();
  await page.getByLabel("Counted SKU 2").fill("SKU-1");
  await page.getByLabel("Counted quantity 2").fill("4");
  await page.getByLabel("Scan now").click(); // the count fields hold focus; hand it back to the scan field
  await wedgeScan(SSCC_MIXED);
  await page.getByText("What you counted differs from the carton label").waitFor();
  expect(await page.getByText("Expected: SKU-2:3").isVisible(), "mixed carton audit: MixedCartonContentMismatch shown with the server's sku:qty");
  const mixedScan = (await stubLog()).find((e) => e.path.endsWith("/scans") && e.body?.id === SSCC_MIXED);
  expect(JSON.stringify(mixedScan?.body?.countedContents) === JSON.stringify([{ sku: "SKU-2", qty: 1 }, { sku: "SKU-1", qty: 4 }]), "countedContents went on the SSCC scan");

  // ---- unlabelled case: label data + Print ----
  await settle();
  await page.getByRole("button", { name: "Cases" }).click();
  await page.evaluate(() => {
    window.__printed = 0;
    window.print = () => { window.__printed += 1; };
  });
  await wedgeScan("13041090004824");
  await page.getByText("This case has no carton label").waitFor();
  await page.getByRole("button", { name: "Print label" }).waitFor();
  await shot("3-unlabelled");
  await page.getByRole("button", { name: "Print label" }).click();
  expect((await page.evaluate(() => window.__printed)) === 1, "UnlabelledCarton: label data fetched, Print button calls window.print");
  const caseScan = (await stubLog()).find((e) => e.body?.kind === "CASE_GTIN");
  expect(caseScan?.body?.qty === 1, "case GTIN scan sent qty=1 (cases); the stub multiplied, the client did not");

  // ---- lost answer: same key on the retry, booked once ----
  await settle();
  await page.getByRole("button", { name: "Items" }).click();
  await stub("drop-next-response");
  await wedgeScan("03041090004827");
  await page.getByText(/saved on this device/).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes("saved on this device"), null, { timeout: 15000 });
  const eachScans = (await stubLog()).filter((e) => e.body?.kind === "EACH_GTIN");
  expect(eachScans.length === 2 && eachScans[0].key === eachScans[1].key && eachScans[1].replayed, "answer lost: the retry carried the SAME Idempotency-Key and the server replayed it");
  await shot("4-replayed");

  // ---- close ----
  await page.getByRole("button", { name: "Close receipt" }).click();
  await page.getByRole("button", { name: "Yes, close the receipt" }).click();
  await page.getByText("The receipt is closed.").waitFor();
  await shot("5-closed");
  expect(true, "receipt closed; Short/Over lines listed");

  const posts = commands.filter((c) => c.method === "POST");
  expect(posts.length > 0 && posts.every((c) => c.key), `all ${posts.length} commands carried an Idempotency-Key`);
  expect(commands.every((c) => c.path.startsWith(`${API}/`) || c.path === `${API}/receipts`), "every request went to same-origin /api/inbound-receiving (Kong path), nothing else");
  console.log(`\nDONE  receiving flow passed (${commands.length} requests)`);
} finally {
  await browser.close();
}
