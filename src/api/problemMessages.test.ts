import { describe, expect, it } from "vitest";
import { describeProblem, describeQueued } from "./problemMessages";
import type { Problem } from "../lib/problem";

const T = "https://errors.fulfillment-execution.warehouse-systems.dev";
const p = (slug: string, status: number, title = "T", detail = "usecases: x"): Problem => ({ type: `${T}/${slug}`, title, status, detail });

describe("describeProblem", () => {
  it.each([
    "station-not-found",
    "no-claimable-task",
    "station-occupied",
    "station-not-occupied",
    "task-not-found",
    "task-not-claimed",
    "task-not-owner",
    "task-already-completed",
    "invalid-request",
    "idempotency-key-required",
    "idempotency-key-reused",
    "station-location-not-workcenter",
    "relocation-confirmation-required",
    "invalid-relocation-confirmation",
    "not-relocation-task",
    "replenishment-confirmation-required",
    "invalid-replenishment-confirmation",
    "unknown-gtin",
    "invalid-scanned-gtin",
    "scan-sku-mismatch",
    "scan-level-mismatch",
    "pick-over-quantity",
    "no-pick-plan",
    "case-break-rejected",
    "not-case-break-task",
    "case-break-completion-required",
    "case-break-unavailable",
    "internal-error",
  ])("%s has a what and a to-do and never echoes the engineer-facing detail", (slug) => {
    const m = describeProblem(p(slug, 409, "Title", "usecases: engineer wording"));
    expect(m.what.length).toBeGreaterThan(10);
    expect(m.todo.length).toBeGreaterThan(5);
    expect(`${m.what} ${m.todo}`).not.toContain("usecases");
  });

  it("explains a gateway HTML 404 as a setup problem, and a 5xx as the service not answering", () => {
    expect(describeProblem({ type: "about:blank", title: "Not Found", status: 404 }).what).toMatch(/cannot be reached/);
    expect(describeProblem({ type: "about:blank", title: "Bad Gateway", status: 502 }).what).toMatch(/not answering/);
  });

  it("falls back to the service's own category title for a code this build does not know", () => {
    const m = describeProblem(p("brand-new-code", 422, "Something new happened"));
    expect(m.what).toBe("Something new happened.");
    expect(m.todo).toMatch(/call your lead/);
  });
});

describe("describeQueued", () => {
  it("tells the operator the action is saved and that they need not repeat it", () => {
    const m = describeQueued("completion", "offline");
    expect(m.what).toMatch(/offline.*completion is saved/);
    expect(m.todo).toMatch(/do not need to repeat/);
  });
});
