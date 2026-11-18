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
// a truck is turned away. Then the two gate rules of a stricter site (stub yard policy):
// a minimum seal strength (refused with none stated, admitted once the clerk states it)
// and a suspended carrier (turned away and on record once, online and after an offline
// replay; the truck's form is gone, so a stray tap or Enter cannot record it twice).
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
const stub = (path, body) => fetch(`${STUB}/__stub/${path}`, { method: "POST", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
const visitsOf = async (plate, state) => (await (await fetch(`${STUB}${API}/visits?siteId=WH1&tractorPlate=${plate}${state ? `&state=${state}` : ""}`)).json()).items;
const checkInsOf = async (plate) => (await stubLog()).filter((e) => e.path === `${API}/visits` && e.body?.tractorPlate === plate);
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

  // ---- gate: a site with a minimum seal strength (yard-management ADR 0012) ----
  await stub("yard-policy", { minimumSealClass: "S", suspendedCarrierAction: "REJECT" });
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await page.getByLabel("Carrier", { exact: true }).fill("Sealed Lines");
  await page.getByLabel("Tractor plate").fill("seal55");
  await page.getByLabel("Purpose").selectOption("DROP");
  await scan("Scan the trailer unit number", "E2E-SEAL-1");
  await page.getByLabel("Kind of trailer 1").selectOption("DRY_VAN");
  await page.getByLabel("Load state 1").selectOption("LOADED");
  expect((await page.getByLabel("Seal strength 1 (optional)").count()) === 0, "seal strength is not asked for while no seal number is typed");
  await page.getByLabel("Seal number 1 (optional)").fill("SL-900");
  await page.getByRole("button", { name: "Check in this truck" }).click();
  await page.getByText(/this trailer's seal is weaker or its strength was not stated/).waitFor();
  expect((await page.getByLabel("Tractor plate").inputValue()) === "seal55" && (await visitsOf("SEAL55")).length === 0, "seal with no strength stated: refused in words, nothing recorded, the form keeps the truck");
  await shot("7-seal-strength-needed");
  const box = await page.getByLabel("Seal strength 1 (optional)").boundingBox();
  expect(box !== null && box.height >= 48, `seal strength is a large touch target (${box?.height}px high)`);
  await page.getByLabel("Seal strength 1 (optional)").selectOption({ label: "Security seal (S)" });
  await page.getByRole("button", { name: "Check in this truck" }).click();
  await page.getByText("SEAL55 is checked in.").waitFor();
  const seals = await checkInsOf("SEAL55");
  expect(
    seals.length === 2 && !("sealClass" in seals[0].body.trailers[0]) && seals[1].body.trailers[0].sealClass === "S" && seals[0].key !== seals[1].key,
    "seal strength: left out of the first request (no empty string), sent as sealClass S in the second, which is a new request with a new key",
  );
  await shot("8-seal-strength-accepted");

  // ---- gate: a suspended carrier is turned away once (yard-management ADR 0016) ----
  const suspendedTruck = async (plate, unit) => {
    await page.getByLabel("Carrier", { exact: true }).fill("Suspended Haulage");
    await page.getByLabel("Carrier code (optional)").fill("susp");
    await page.getByLabel("Tractor plate").fill(plate);
    await page.getByLabel("Purpose").selectOption("DROP");
    await settle();
    await scan("Scan the trailer unit number", unit);
    await page.getByLabel("Kind of trailer 1").selectOption("DRY_VAN");
    await page.getByLabel("Load state 1").selectOption("EMPTY");
  };
  const formIsGone = async () => (await page.getByRole("button", { name: "Check in this truck" }).count()) === 0 && (await page.getByLabel("Tractor plate").count()) === 0;
  await suspendedTruck("susp99", "E2E-SUSP-1");
  await page.getByRole("button", { name: "Check in this truck" }).click();
  await page.getByRole("heading", { name: "SUSP99 is turned away" }).waitFor();
  await page.getByText("This carrier is suspended, so the truck is turned away. The turn-away is already recorded.").waitFor();
  await shot("9-turned-away");
  expect(await formIsGone(), "suspended carrier: the truck's form is gone, there is nothing left to submit");
  await page.keyboard.press("Enter"); // a stray scanner Enter
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await page.getByRole("heading", { name: "SUSP99 is turned away" }).waitFor();
  expect(await formIsGone(), "the turned-away state survives a look at another gate job");
  const once = await visitsOf("SUSP99");
  expect(
    (await checkInsOf("SUSP99")).length === 1 && once.length === 1 && once[0].state === "REJECTED" && once[0].rejectionReason === "CARRIER_SUSPENDED" && once[0].trailersIn.length === 0,
    "suspended carrier: one request, one REJECTED visit (CARRIER_SUSPENDED) on record, no trailer",
  );
  await page.getByRole("button", { name: "Start the next truck" }).click();
  expect((await page.getByLabel("Tractor plate").inputValue()) === "" && (await page.getByLabel("Carrier", { exact: true }).inputValue()) === "", "one explicit action starts the next truck on an empty form");

  // The same refusal arriving on a replay: saved offline, answered when the network is back.
  await suspendedTruck("susp77", "E2E-SUSP-2");
  await context.setOffline(true);
  await page.getByText("You are offline").waitFor();
  await page.getByRole("button", { name: "Check in this truck" }).click();
  await page.getByText(/Your check-in is saved on this device/).waitFor();
  await context.setOffline(false);
  await page.getByRole("heading", { name: "SUSP77 is turned away" }).waitFor({ timeout: 20000 });
  expect(await formIsGone(), "replayed refusal: the form that was still filled is gone");
  expect((await page.getByText(/Try again/).count()) === 0, "replayed refusal: one message, and it does not say to try again");
  await page.waitForTimeout(6500); // longer than the outbox retry interval: a retry would show up in the stub log
  const replayed = await visitsOf("SUSP77", "REJECTED");
  expect((await checkInsOf("SUSP77")).length === 1 && replayed.length === 1, "replayed refusal: sent once, never retried, one REJECTED visit on record");
  await shot("10-turned-away-after-replay");
  await page.getByRole("button", { name: "Start the next truck" }).click();
  await stub("yard-policy", { minimumSealClass: null, suspendedCarrierAction: "NONE" });

  // ---- the rules of the repo ----
  const posts = requests.filter((r) => r.method === "POST");
  expect(posts.length > 0 && posts.every((r) => r.key), `all ${posts.length} commands carried an Idempotency-Key`);
  expect(requests.every((r) => r.path.startsWith(`${API}/`)), "every request went to same-origin /api/yard-management (Kong path), nothing else");
  console.log(`\nDONE  yard flow passed (${requests.length} requests)`);
} finally {
  await browser.close();
}
