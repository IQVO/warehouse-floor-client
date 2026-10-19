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
  await (MODE === "real" ? realFlow() : stubFlow());
  console.log(`\nDONE  ${MODE} flow passed (${commands.length} commands)`);
} finally {
  await browser.close();
}
