#!/usr/bin/env node
// Drives the station flow in headless Chromium against a running dev server (or
// preview) and prints one line per verified behaviour. Exits non-zero on the
// first failed expectation.
//
//   E2E_MODE=stub  (default)  needs `npm run stub-api` (STUB_LEASE_MS=20000 shows a renewal fast)
//                             and `FLOOR_API_TARGET=http://localhost:8787 npm run dev`
//   E2E_MODE=real             needs a dev server proxying /api to Kong (the default target,
//                             http://localhost:8000). Registers a throwaway station, checks in,
//                             and only claims if the queue shows work; it never completes real work.
//
//   E2E_BASE   page origin           (default http://localhost:5174)
//   STUB_URL   stub control origin   (default http://localhost:8787)
//   E2E_SHOTS  screenshot directory  (default ./e2e-shots)
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:5174";
const MODE = process.env.E2E_MODE ?? "stub";
const STUB = process.env.STUB_URL ?? "http://localhost:8787";
const SHOTS = process.env.E2E_SHOTS ?? "e2e-shots";
const API = "/api/fulfillment-execution";
mkdirSync(SHOTS, { recursive: true });

const ok = (msg) => console.log(`PASS  ${msg}`);
function expect(cond, msg) {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  ok(msg);
}

// E2E_CHROMIUM: use an already-installed Chromium instead of `npx playwright install`.
const browser = await chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 420, height: 860 }, hasTouch: true });
const page = await context.newPage();
const commands = []; // every /api request the BROWSER made, with its Idempotency-Key
page.on("request", (r) => {
  if (new URL(r.url()).pathname.startsWith("/api/") && r.method() !== "GET") {
    commands.push({ method: r.method(), path: new URL(r.url()).pathname, key: r.headers()["idempotency-key"] ?? null });
  }
});
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const stubLog = async () => (await fetch(`${STUB}/__stub/log`)).json();
const stub = (path, body) => fetch(`${STUB}/__stub/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

/** Emulates a keyboard-wedge scanner: fast keystrokes, then Enter, with NO input focused by the test. */
async function wedgeScan(code) {
  await page.keyboard.type(code, { delay: 4 });
  await page.keyboard.press("Enter");
}

/** Like wedgeScan, for codes holding control characters (the GS1-128 GS separator, 0x1D) that key presses cannot type. */
async function wedgeScanRaw(code) {
  await page.locator("input.floor-scan__input").focus();
  await page.keyboard.insertText(code);
  await page.keyboard.press("Enter");
}

const GS = "\u001d";
const SKU1_EACH_EAN13 = "3041090004827"; // 14-digit 03041090004827
const SKU1_CASE_ITF14 = "13041090004824"; // a case of 12 of SKU-1
const SKU2_EACH_EAN13 = "4006381333931"; // another product

async function registerAndCheckIn(stationId, badge) {
  await page.goto(BASE + "/");
  await page.getByLabel("Station ID").fill(stationId);
  await page.getByRole("button", { name: "Register station" }).click();
  await page.getByText(`Station ${stationId} is registered.`).waitFor();
  // Focus-lock: click on empty page space (dropping focus on <body>), then "scan" with no field focused.
  await page.getByLabel("Scan your badge").waitFor();
  await page.mouse.click(5, 400);
  await wedgeScan(badge);
  await page.getByText(`Checked in as ${badge}.`).waitFor();
  expect(true, `focus-locked scan input captured the badge scan (${badge}) with nothing focused`);
}

async function stubFlow() {
  await stub("reset");
  const station = `floor-e2e-${Date.now()}`;
  await registerAndCheckIn(station, "worker-42");
  await shot("1-checked-in");

  // ---- claim -> task screen -> scan-to-confirm -> complete, with a lost response in the middle ----
  await page.getByRole("button", { name: "Pick" }).click();
  await page.getByRole("heading", { name: /PICK task/ }).waitFor();
  const timer = (await page.getByRole("timer").textContent()) ?? "";
  expect(/^\d+:\d\d$/.test(timer), `task screen shows the claimed task and a lease countdown (${timer})`);
  await shot("2-task");

  await page.mouse.click(5, 400);
  await wedgeScan("order-99");
  await page.getByText("That is not the right one").waitFor();
  expect(await page.getByRole("button", { name: "Complete task" }).isDisabled(), "a wrong scan keeps Complete locked");
  await wedgeScan("order-42");
  expect(await page.getByRole("button", { name: "Complete task" }).isEnabled(), "the right scan unlocks Complete");

  // The next command is applied by the server but its answer is cut: the client must keep and reuse its key.
  await stub("drop-next-response");
  await page.getByRole("button", { name: "Complete task" }).click();
  await page.getByText("Completion saved on this device.").waitFor();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wfc.outbox.v1") ?? "[]"));
  expect(saved.length === 1 && saved[0].kind === "complete", "the unanswered completion is persisted in the outbox (localStorage)");
  const savedKey = saved[0].key;
  await shot("3-completion-saved");

  // Reload: a new page load must resume with the stored key, not mint another.
  await page.reload();
  await page.getByText("You are not holding a task.").waitFor({ timeout: 15000 });
  const completes = (await stubLog()).filter((e) => e.path.endsWith("/complete"));
  expect(completes.length === 2, "server received the completion twice (original + replay after reload)");
  expect(completes.every((e) => e.key === savedKey), `both attempts carried the SAME Idempotency-Key (${savedKey})`);
  expect(completes[0].replayed === false && completes[1].replayed === true, "the server applied it once and replayed its stored answer the second time");
  expect((await page.evaluate(() => localStorage.getItem("wfc.outbox.v1"))) === "[]", "outbox is empty after the replay was answered");
  await shot("4-after-replay");

  // ---- offline: banner, queue, replay on reconnect ----
  await page.getByRole("link", { name: "Pull the next task" }).click();
  await page.getByRole("button", { name: "Pick" }).click();
  await page.getByRole("heading", { name: /PICK task/ }).waitFor();
  await page.mouse.click(5, 400);
  await wedgeScan("order-43");
  await page.getByRole("button", { name: "Complete task" }).waitFor();
  await context.setOffline(true);
  await page.getByText("You are offline").waitFor();
  await shot("5-offline-banner");
  await page.getByRole("button", { name: "Complete task" }).click();
  await page.getByText("Completion saved on this device.").waitFor();
  const before = (await stubLog()).filter((e) => e.path.endsWith("/complete")).length;
  const offlineKey = (await page.evaluate(() => JSON.parse(localStorage.getItem("wfc.outbox.v1") ?? "[]")))[0]?.key;
  expect(before === 2, "nothing was sent while offline (the stub saw no new completion)");
  await context.setOffline(false);
  await page.getByText("You are not holding a task.").waitFor({ timeout: 15000 });
  const after = (await stubLog()).filter((e) => e.path.endsWith("/complete"));
  expect(after.length === 3 && after[2].key === offlineKey && !after[2].replayed, "on reconnect the saved completion was sent once, with its saved key");
  await shot("6-after-reconnect");

  // ---- no work: 409 no-claimable-task in plain words ----
  await page.getByRole("link", { name: "Pull the next task" }).click();
  await page.getByRole("button", { name: "Pick" }).click();
  await page.getByText("No work is waiting for this station right now.").waitFor();
  const notice = (await page.getByRole("status").first().textContent()) ?? "";
  expect(!/\{|usecases|409/.test(notice), "no-claimable-task is shown as plain words, not JSON");
  await shot("7-no-work");

  // ---- lease renewal on a timer (needs STUB_LEASE_MS small; skipped otherwise) ----
  await stub("tasks", { id: "lease-task", type: "PICK", cpt: "2026-01-02T00:00:00Z", orderRef: "order-77", requiredCapabilities: ["pick"] });
  await page.getByRole("button", { name: "Pick" }).click();
  await page.getByRole("heading", { name: /PICK task/ }).waitFor();
  const leaseSeconds = await page.evaluate(() => {
    const [m, s] = document.querySelector("[role=timer]").textContent.split(":").map(Number);
    return m * 60 + s;
  });
  if (leaseSeconds <= 60) {
    await page.waitForTimeout((leaseSeconds / 2 + 3) * 1000);
    const renewals = (await stubLog()).filter((e) => e.path.endsWith("/renew-lease"));
    expect(renewals.length >= 1 && renewals[0].key !== null, `the lease was renewed on a timer at half-life (${renewals.length} renew-lease call(s), each with a key)`);
    const t2 = await page.getByRole("timer").textContent();
    expect(/^\d+:\d\d$/.test(t2 ?? ""), `countdown visible after renewal (${t2})`);
    await shot("8-lease-renewed");
  } else {
    console.log(`SKIP  lease renewal: lease is ${leaseSeconds}s; start the stub with STUB_LEASE_MS=20000`);
  }

  // ---- every command carried a key; different actions got different keys ----
  const keyed = commands.filter((c) => !c.path.includes("/renew-lease") || c.key);
  expect(commands.length > 0 && commands.every((c) => c.key), `all ${commands.length} commands the browser sent carried an Idempotency-Key`);
  expect(commands.every((c) => c.path.startsWith(API + "/")), "every request went to same-origin /api/fulfillment-execution (Kong path), nothing else");
  void keyed;
}

const pickScans = async () => (await stubLog()).filter((e) => e.path.endsWith("/scans"));

/** R14 pick side: case pick by GS1-128 / ITF-14 scans, with refusals, an offline scan and a lost answer. */
async function casePickFlow() {
  await stub("reset");
  await page.evaluate(() => localStorage.clear());
  const station = `floor-e2e-case-${Date.now()}`;
  // 24 eaches planned = 2 cases of 12, picked as CASE.
  await stub("tasks", { id: "case-pick-1", type: "PICK", cpt: "2026-01-01T00:00:00Z", orderRef: "order-61", requiredCapabilities: ["pick"], pick: { sku: "SKU-1", plannedEaches: 24, unit: "CASE" } });
  await registerAndCheckIn(station, "worker-42");
  await page.getByRole("button", { name: "Pick" }).click();
  await page.getByRole("heading", { name: /PICK task/ }).waitFor();
  await page.mouse.click(5, 400);

  // refused on the device: no request leaves
  await wedgeScan("3041090004828"); // bad check digit
  await page.getByText(/misread/).waitFor();
  await wedgeScan("340123450000000017"); // an SSCC label
  await page.getByText(/carton \(SSCC\) label/).waitFor();
  expect((await pickScans()).length === 0, "a bad check digit and an SSCC were refused on the device (no request sent)");

  // the server refuses the each-EAN printed on a case, and another product
  await wedgeScan(SKU1_EACH_EAN13);
  await page.getByText(/case where single items are picked/).waitFor();
  await wedgeScan(SKU2_EACH_EAN13);
  await page.getByText(/not the item for this pick/).waitFor();
  const refused = await pickScans();
  expect(refused.length === 2 && refused[0].body.gtin === "03041090004827" && refused[0].body.count === 1, "scan-level-mismatch and scan-sku-mismatch came back as plain words (14-digit GTIN, count 1 sent)");
  await shot("9-case-pick-refused");

  // GS1-128 case label with GS-separated lot and expiry (AI 01, 10, 17): the lot is parsed, only the GTIN is sent
  await wedgeScanRaw(`]C101${SKU1_CASE_ITF14}10LOT-A1B2${GS}17261231`);
  await page.getByText(/Picked 12 of 24 eaches/).waitFor();
  // a lost answer: applied by the server, cut before the client heard; the client keeps the key and replays it
  await stub("drop-next-response");
  await wedgeScan(`]I1${SKU1_CASE_ITF14}`);
  await page.getByText(/1 scan is saved on this device/).waitFor();
  const savedScan = (await page.evaluate(() => JSON.parse(localStorage.getItem("wfc.outbox.v1") ?? "[]")))[0];
  expect(savedScan?.kind === "pick-scan" && savedScan.body.gtin === SKU1_CASE_ITF14, "the unanswered scan is persisted in the outbox with its body");
  await page.getByText(/Picked 24 of 24 eaches/).waitFor({ timeout: 15000 });
  const scans = await pickScans();
  const lost = scans.filter((e) => e.key === savedScan.key);
  expect(lost.length === 2 && lost[0].replayed === false && lost[1].replayed === true, "the lost scan was replayed with the SAME Idempotency-Key and answered from the server's stored reply (counted once)");
  expect(new Set(scans.filter((e) => !e.replayed).map((e) => e.key)).size === scans.filter((e) => !e.replayed).length, "every distinct physical scan got its own key");

  // a third case would pick more than planned
  await wedgeScan(`]I1${SKU1_CASE_ITF14}`);
  await page.getByText(/more than this task asks for/).waitFor();
  await shot("10-case-pick-done");

  // the order label unlocks Complete after the item scans
  await wedgeScan("order-61");
  await page.getByRole("button", { name: "Complete task" }).waitFor();
  await page.getByRole("button", { name: "Complete task" }).click();
  await page.getByText(`Task case-pick-1 completed.`).waitFor();
  expect(true, "case pick completed after the order-label scan");

  // offline scan on a second pick: saved, then sent once on reconnect with its key
  await stub("tasks", { id: "each-pick-1", type: "PICK", cpt: "2026-01-02T00:00:00Z", orderRef: "order-62", requiredCapabilities: ["pick"], pick: { sku: "SKU-1", plannedEaches: 12, unit: "EACH" } });
  await page.getByRole("link", { name: "Pull the next task" }).click();
  await page.getByRole("button", { name: "Pick" }).click();
  await page.getByRole("heading", { name: /PICK task/ }).waitFor();
  await page.mouse.click(5, 400);
  await context.setOffline(true);
  await page.getByText("You are offline").waitFor();
  const beforeOffline = (await pickScans()).length;
  await wedgeScan(SKU1_EACH_EAN13);
  await page.getByText(/1 scan is saved on this device/).waitFor();
  expect((await pickScans()).length === beforeOffline, "an offline scan sent nothing");
  const offlineKey = (await page.evaluate(() => JSON.parse(localStorage.getItem("wfc.outbox.v1") ?? "[]")))[0]?.key;
  await context.setOffline(false);
  await page.getByText(/Picked 1 of 12 eaches/).waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => localStorage.getItem("wfc.outbox.v1") === "[]", null, { timeout: 15000 });
  const sent = (await pickScans()).filter((e) => e.key === offlineKey);
  expect(sent.length === 1 && sent[0].body.gtin === "03041090004827", "on reconnect the saved each scan was sent once, with its saved key");
  await shot("11-offline-scan-sent");
}

/** R14: BREAK_CASE screen; the case break survives a lost answer and a reload with its Idempotency-Key. */
async function breakCaseFlow() {
  await stub("reset");
  await page.evaluate(() => localStorage.clear());
  const station = `floor-e2e-break-${Date.now()}`;
  await stub("tasks", { id: "break-1", type: "BREAK_CASE", cpt: "2026-01-01T00:00:00Z", orderRef: "order-63", requiredCapabilities: ["pick"] });
  await registerAndCheckIn(station, "worker-42");
  // claim-next does not offer BREAK_CASE (AnyTaskType); the stub leases it the way the pool would.
  const leased = await (await stub("claim", { taskId: "break-1", stationId: station })).json();
  await page.evaluate(
    ([task]) => {
      const s = JSON.parse(localStorage.getItem("wfc.station.v1"));
      s.held = { task, leaseDurationMs: 300000, leaseExpiresAt: Date.now() + 300000 };
      localStorage.setItem("wfc.station.v1", JSON.stringify(s));
    },
    [leased],
  );
  await page.reload();
  await page.goto(BASE + "/task");
  await page.getByRole("heading", { name: /BREAK_CASE task/ }).waitFor();
  expect((await page.getByRole("button", { name: "Complete task" }).count()) === 0, "a BREAK_CASE task has no plain Complete button (the service refuses it)");
  await shot("12-break-case");

  await stub("drop-next-response");
  await page.getByRole("button", { name: "Break case" }).click();
  await page.getByText("Case break saved on this device.").waitFor();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wfc.outbox.v1") ?? "[]"));
  expect(saved.length === 1 && saved[0].kind === "break-case", "the unanswered case break is persisted in the outbox");
  await page.reload();
  await page.getByText("You are not holding a task.").waitFor({ timeout: 15000 });
  const breaks = (await stubLog()).filter((e) => e.path.endsWith("/break-case"));
  expect(breaks.length === 2 && breaks.every((e) => e.key === saved[0].key) && breaks[1].replayed === true, "the case break was replayed after reload with the SAME Idempotency-Key (applied once)");
  expect(breaks[0].body.stationId === station && Object.keys(breaks[0].body).length === 1, "break-case body is {stationId} only");
  await shot("13-break-case-done");
}

async function realFlow() {
  const station = `floor-e2e-${Date.now()}`;
  const health = await page.request.get(BASE + `${API}/healthz`);
  expect(health.ok(), `GET ${API}/healthz through the dev proxy -> ${health.status()}`);
  const depths = {};
  for (const type of ["PICK", "RELOCATE", "REPLENISH"]) {
    const r = await page.request.get(BASE + `${API}/queues/${type}/depth`);
    depths[type] = (await r.json()).depth;
  }
  console.log(`INFO  queue depths (read-only): ${JSON.stringify(depths)}`);

  await registerAndCheckIn(station, "floor-e2e-badge");
  const claimable = Object.entries(depths).filter(([, d]) => d > 0).map(([t]) => t);
  if (claimable.length === 0) {
    // Station has only the "pick" capability and the pool is empty, so this claim cannot lease anything.
    await page.getByRole("button", { name: "Pick" }).click();
    await page.getByText("No work is waiting for this station right now.").waitFor();
    expect(true, "real service answered claim-next with 409 no-claimable-task; UI showed the plain-words message (no work to claim, none created)");
    await shot("real-no-work");
  } else {
    console.log(`INFO  claimable work exists (${claimable.join(", ")}) but is not ours; not claiming it`);
  }
  await page.getByRole("button", { name: "Check out" }).click();
  await page.getByText("Checked out.").waitFor();
  expect(true, "check-out against the real service succeeded");
  await shot("real-checked-out");
  console.log(`INFO  real-service commands:\n${commands.map((c) => `      ${c.method} ${c.path} key=${c.key}`).join("\n")}`);
}

try {
  if (MODE === "real") await realFlow();
  else {
    await stubFlow();
    await casePickFlow();
    await breakCaseFlow();
  }
  console.log(`\nDONE  ${MODE} flow passed (${commands.length} commands)`);
} finally {
  await browser.close();
}
