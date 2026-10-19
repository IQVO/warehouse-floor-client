import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./register";

describe("registerServiceWorker", () => {
  it("registers /sw.js at the root scope when enabled and supported", () => {
    const register = vi.fn().mockResolvedValue(undefined);
    registerServiceWorker({ serviceWorker: { register } as unknown as ServiceWorkerContainer }, true);
    // jsdom's document is already "complete", so registration is immediate
    expect(register).toHaveBeenCalledExactlyOnceWith("/sw.js", { scope: "/" });
  });

  it("does nothing outside production builds", () => {
    const register = vi.fn();
    registerServiceWorker({ serviceWorker: { register } as unknown as ServiceWorkerContainer }, false);
    expect(register).not.toHaveBeenCalled();
  });

  it("does nothing where service workers do not exist (plain-http LAN hosts)", () => {
    expect(() => registerServiceWorker({}, true)).not.toThrow();
  });

  it("logs, without throwing, when registration is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const register = vi.fn().mockRejectedValue(new Error("nope\r\nforged"));
    registerServiceWorker({ serviceWorker: { register } as unknown as ServiceWorkerContainer }, true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(String(warn.mock.calls[0]?.[0])).not.toMatch(/[\r\n]/);
    warn.mockRestore();
  });
});
