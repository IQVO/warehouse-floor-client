#!/usr/bin/env node
// Drives the yard flow (gate clerk, dock operator, hostler) in headless Chromium
// against a running dev server and the stub (`npm run stub-api`,
// `FLOOR_API_TARGET=http://localhost:8787 npm run dev`). Prints one line per
// verified behaviour; exits non-zero on the first failure.
//
//   E2E_BASE (default http://localhost:5174)   STUB_URL (default http://localhost:8787)
//   E2E_SHOTS (default ./e2e-shots)            E2E_CHROMIUM = path of an installed Chromium
//
// The day: a live unload with an appointment is checked in (the first answer is lost
// and replayed with the SAME key), its driver's arrival is confirmed at the door, door
// work runs, the truck is checked out; a walk-in drops a trailer at the holding spot;
// a hostler claims the seeded relocation and parks it somewhere else with a reason;
// a truck is turned away.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:5174";
const STUB = process.env.STUB_URL ?? "http://localhost:8787";
const SHOTS = process.env.E2E_SHOTS ?? "e2e-shots";
const API = "/api/yard-management";
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
const requests = [];
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith("/api/")) requests.push({ method: r.method(), path: u.pathname, key: r.headers()["idempotency-key"] ?? null });
});
const shot = (name) => page.screenshot({ path: `${SHOTS}/yard-${name}.png` });
const stubLog = async () => (await fetch(`${STUB}/__stub/log`)).json();
const stub = (path) => fetch(`${STUB}/__stub/${path}`, { method: "POST" });
const settle = () => page.waitForTimeout(450); // past the scanner de-bounce
/** Keyboard-wedge emulation on a scan field: focus it, type fast, Enter. */
async function scan(label, code) {
  await page.getByLabel(label).click();
  await page.keyboard.type(code, { delay: 4 });
  await page.keyboard.press("Enter");
}
const nav = (name) => page.getByRole("link", { name, exact: true }).first().click();

try {
  await stub("reset");

  // ---- gate: check in a live unload with an appointment; the answer is lost once ----
  await page.goto(`${BASE}/yard/gate`);
  await page.getByLabel("Site code").fill("WH1");
  await page.getByLabel("Carrier", { exact: true }).fill("Acme Freight");
  await page.getByLabel("Carrier code (optional)").fill("acme");
  await page.getByLabel("Tractor plate").fill("e2e1234");
  await page.getByLabel("Appointment id (optional)").fill("appt-stub-1");
  await page.getByLabel("Purpose").selectOption("LIVE_UNLOAD");
  await scan("Scan the trailer unit number", "E2E-TRL-1");
  await page.getByLabel("Kind of trailer 1").selectOption("DRY_VAN");
  await page.getByLabel("Load state 1").selectOption("LOADED");
  await page.getByLabel("Seal number 1 (optional)").fill("SEAL-100");
  await shot("1-check-in-form");
  await stub("drop-next-response");
  await page.getByRole("button", { name: "Check in this truck" }).click();
  await page.getByText(/Your check-in is saved on this device/).waitFor();
  await page.getByText("E2E1234 is checked in.").waitFor({ timeout: 20000 });
  await page.getByText(/Take E2E-TRL-1 to Door WH1-DOCK-IN-01/).waitFor();
  await shot("2-checked-in");
  const ins = (await stubLog()).filter((e) => e.path === `${API}/visits`);
  expect(ins.length === 2 && ins[0].key === ins[1].key && ins[1].replayed, "check-in: answer lost, the retry carried the SAME Idempotency-Key and the server replayed it (one visit)");
  expect(
    ins[0].body.appointmentId === "appt-stub-1" && ins[0].body.trailers.length === 1 && ins[0].body.tractorPlate === "E2E1234" && ins[0].body.carrierScac === "ACME",
    "check-in body: appointment, exactly one trailer, plate and carrier code in capitals",
  );

  // ---- dock: confirm the driver's arrival at the door, then door work ----
  await nav("Dock");
  await page.getByRole("button", { name: "E2E-TRL-1" }).click();
  await scan("Scan the spot or door where the trailer is", "WH1-DOCK-IN-01");
  await page.getByText("At the planned place: Door WH1-DOCK-IN-01.").waitFor();
  await page.getByRole("button", { name: "Complete move" }).click();
  await page.getByText("The trailer is at WH1-DOCK-IN-01.").waitFor();
  const arrival = (await stubLog()).find((e) => e.path.endsWith("/completions"));
  expect(arrival.body.hostlerRef === undefined && arrival.body.actualLocation.code === "WH1-DOCK-IN-01", "visiting-driver move completed by the dock operator with the scanned door and no hostlerRef");
  await page.getByRole("heading", { name: "Door WH1-DOCK-IN-01: E2E-TRL-1" }).waitFor();
  await page.getByRole("button", { name: "Start door work on E2E-TRL-1" }).click();
  await page.getByText("Door work started on E2E-TRL-1.").waitFor();
  await page.getByLabel("Load state when finished (E2E-TRL-1)").selectOption("EMPTY");
  await page.getByRole("button", { name: "Complete door work on E2E-TRL-1" }).click();
  await page.getByText("Door work done on E2E-TRL-1.").waitFor();
  await shot("3-door-work-done");
  expect(true, "dock: trailer listed at its door, door work started and completed (load state EMPTY)");

  // ---- gate: check the live truck out with its trailer ----
  await nav("Gate");
  await page.getByRole("button", { name: "Check out", exact: true }).click();
  await page.getByRole("button", { name: "E2E1234" }).click();
  expect(await page.getByLabel("Take out E2E-TRL-1").isChecked(), "check-out: the ready trailer of a live visit is ticked");
  await page.getByRole("button", { name: "Check out this truck" }).click();
  await page.getByText("E2E1234 is checked out.").waitFor();
  await shot("4-checked-out");

  // ---- gate: a walk-in drops a trailer; the dock confirms it at the holding spot ----
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await page.getByLabel("Carrier", { exact: true }).fill("Walk In Haulage");
  await page.getByLabel("Tractor plate").fill("walk77");
  await page.getByLabel("Purpose").selectOption("DROP");
  await scan("Scan the trailer unit number", "E2E-DROP-1");
  await page.getByLabel("Kind of trailer 1").selectOption("REEFER");
  await page.getByLabel("Load state 1").selectOption("EMPTY");
  await page.getByRole("button", { name: "Check in this truck" }).click();
  await page.getByText(/Take E2E-DROP-1 to Spot WH1-HOLD-01 \(to the holding area\)/).waitFor();
  await nav("Dock");
  await page.getByRole("button", { name: "E2E-DROP-1" }).click();
  await scan("Scan the spot or door where the trailer is", "WH1-HOLD-01");
  await page.getByRole("button", { name: "Complete move" }).click();
  await page.getByText("The trailer is at WH1-HOLD-01.").waitFor();
  expect(true, "walk-in without an appointment goes to the holding spot and its arrival is confirmed");

  // ---- hostler: claim the seeded relocation, park it elsewhere with a reason ----
  await nav("Hostler");
  await page.getByLabel("Your hostler id").fill("e2e-host");
  await page.getByRole("button", { name: "Claim next move" }).click();
  await page.getByText("Your move", { exact: true }).waitFor();
  const facts = await page.locator("dl").last().innerText();
  expect(/SEED-TRL-1|trl-stub/.test(facts) && facts.includes("WH1-YARD-01") && facts.includes("WH1-YARD-02") && facts.includes("relocate"), "claimed move shows trailer, from, to and why");
  expect(/^\d+:\d{2}$/.test((await page.getByRole("timer").innerText()).trim()), "lease countdown is visible");
  await shot("5-hostler-claimed");
  await scan("Scan the spot or door where the trailer is", "WH1-YARD-05");
  await page.getByText("Not the planned place. You scanned WH1-YARD-05.").waitFor();
  expect(await page.getByRole("button", { name: "Complete move" }).isDisabled(), "another place: completion waits for a reason");
  await page.getByLabel("Why is it not at the planned place?").fill("02 was blocked");
  await page.getByRole("button", { name: "Complete move" }).click();
  await page.getByText("Move done. The trailer is at WH1-YARD-05.").waitFor();
  const done = (await stubLog()).filter((e) => e.path.includes("/moves/") && e.path.endsWith("/completions")).at(-1);
  expect(
    done.body.hostlerRef === "e2e-host" && done.body.actualLocation.code === "WH1-YARD-05" && done.body.deviationNote === "02 was blocked",
    "hostler completion sent hostlerRef, the scanned place and the reason",
  );
  await page.getByRole("button", { name: "Claim next move" }).click();
  await page.getByText("No move is waiting for you right now.").waitFor();
  await shot("6-hostler-done");

  // ---- gate: turn a truck away ----
  await nav("Gate");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByLabel("Carrier", { exact: true }).fill("Unbooked Freight");
  await page.getByLabel("Tractor plate").fill("nope1");
  await page.getByLabel("Reason").selectOption("APPOINTMENT_REQUIRED");
  await page.getByRole("button", { name: "Reject at the gate" }).click();
  await page.getByText(/NOPE1 was turned away/).waitFor();
  expect(true, "truck turned away: refusal recorded");

  // ---- the rules of the repo ----
  const posts = requests.filter((r) => r.method === "POST");
  expect(posts.length > 0 && posts.every((r) => r.key), `all ${posts.length} commands carried an Idempotency-Key`);
  expect(requests.every((r) => r.path.startsWith(`${API}/`)), "every request went to same-origin /api/yard-management (Kong path), nothing else");
  console.log(`\nDONE  yard flow passed (${requests.length} requests)`);
} finally {
  await browser.close();
}
