import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * Loads public/sw.js into a sandbox with a fake worker scope + Cache API, with
 * the two build-time placeholders filled in the way build/precacheManifest.ts does.
 */
const PRECACHE = ["/", "/index.html", "/manifest.webmanifest", "/assets/app-abc.js", "/assets/app-abc.css"];
const template = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
const stamp = (precache: string[]) =>
  template.replace("__PRECACHE__", JSON.stringify(precache)).replace("__CACHE_VERSION__", "v1");
const source = stamp(PRECACHE);

type Handler = (event: Record<string, unknown>) => void;

function loadWorker(options: { networkDown?: boolean; source?: string } = {}) {
  const handlers: Record<string, Handler> = {};
  const stored = new Map<string, Response>();
  const cache = {
    addAll: vi.fn(async (requests: Request[]) => {
      for (const r of requests) stored.set(new URL(r.url).pathname, new Response(`cached:${new URL(r.url).pathname}`));
    }),
    match: vi.fn(async (request: Request | string) => {
      const path = typeof request === "string" ? request : new URL(request.url).pathname;
      return stored.get(path);
    }),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ["floor-shell-v0", "floor-shell-v1", "unrelated-cache"]),
    delete: vi.fn(async () => true),
  };
  const network = vi.fn(async () => {
    if (options.networkDown) throw new TypeError("offline");
    return new Response("from-network");
  });
  const self = {
    addEventListener: (type: string, h: Handler) => {
      handlers[type] = h;
    },
    location: { origin: "https://floor.example" },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  // In a real worker `new Request("/")` resolves against the worker's URL; Node needs a base.
  class ScopedRequest extends Request {
    constructor(input: string, init?: RequestInit) {
      super(new URL(input, "https://floor.example").href, init);
    }
  }
  runInNewContext(options.source ?? source, { self, caches, fetch: network, Request: ScopedRequest, Response, URL, Promise, Set });
  return { handlers, cache, caches, network, self };
}

function fetchEvent(url: string, init: { method?: string; mode?: string } = {}) {
  let responded: Promise<Response> | undefined;
  // The worker only reads method, url and mode.
  const request = { method: init.method ?? "GET", url, mode: init.mode ?? "cors" };
  return {
    event: {
      request,
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    },
    get responded() {
      return responded;
    },
  };
}

describe("service worker", () => {
  it("precaches the app shell on install, and nothing else", async () => {
    const w = loadWorker();
    let done: Promise<unknown> | undefined;
    w.handlers.install?.({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    const requests = (w.cache.addAll.mock.calls[0]?.[0] ?? []) as Request[];
    const requested = requests.map((r) => new URL(r.url).pathname);
    expect(requested).toEqual(PRECACHE);
    expect(requested.some((p) => p.startsWith("/api/"))).toBe(false);
    expect(w.self.skipWaiting).toHaveBeenCalled();
  });

  it("on activate drops older shell caches but leaves unrelated ones alone", async () => {
    const w = loadWorker();
    let done: Promise<unknown> | undefined;
    w.handlers.activate?.({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(w.caches.delete).toHaveBeenCalledExactlyOnceWith("floor-shell-v0");
    expect(w.self.clients.claim).toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("never intercepts a %s: commands always go to the network", (method) => {
    const w = loadWorker();
    const e = fetchEvent("https://floor.example/api/fulfillment-execution/tasks/1/complete", { method });
    w.handlers.fetch?.(e.event);
    expect(e.responded).toBeUndefined();
  });

  it("never intercepts a GET under /api/ (no API response is cached or served from cache)", () => {
    const w = loadWorker();
    const e = fetchEvent("https://floor.example/api/fulfillment-execution/queues/PICK/depth");
    w.handlers.fetch?.(e.event);
    expect(e.responded).toBeUndefined();
    expect(w.caches.open).not.toHaveBeenCalled();
  });

  it("keeps /api out of the cache even if a bad build somehow listed an API path in the precache", async () => {
    const api = "/api/fulfillment-execution/queues/PICK/depth";
    const w = loadWorker({ source: stamp([...PRECACHE, api]) });
    let done: Promise<unknown> | undefined;
    w.handlers.install?.({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done; // the poisoned entry is cached ...
    const e = fetchEvent(`https://floor.example${api}`);
    w.handlers.fetch?.(e.event);
    expect(e.responded).toBeUndefined(); // ... but the worker still refuses to serve it
  });

  it("never intercepts a cross-origin GET", () => {
    const w = loadWorker();
    const e = fetchEvent("https://elsewhere.example/assets/app-abc.js");
    w.handlers.fetch?.(e.event);
    expect(e.responded).toBeUndefined();
  });

  it("serves a precached shell asset from the cache", async () => {
    const w = loadWorker();
    let done: Promise<unknown> | undefined;
    w.handlers.install?.({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    const e = fetchEvent("https://floor.example/assets/app-abc.js");
    w.handlers.fetch?.(e.event);
    expect(await (await e.responded)?.text()).toBe("cached:/assets/app-abc.js");
    expect(w.network).not.toHaveBeenCalled();
  });

  it("leaves a GET for something outside the shell to the network", () => {
    const w = loadWorker();
    const e = fetchEvent("https://floor.example/some/other.json");
    w.handlers.fetch?.(e.event);
    expect(e.responded).toBeUndefined();
  });

  it("navigations: network first, and the cached index.html when offline", async () => {
    const online = loadWorker();
    const e1 = fetchEvent("https://floor.example/task", { mode: "navigate" });
    online.handlers.fetch?.(e1.event);
    expect(await (await e1.responded)?.text()).toBe("from-network");

    const offline = loadWorker({ networkDown: true });
    let done: Promise<unknown> | undefined;
    offline.handlers.install?.({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    const e2 = fetchEvent("https://floor.example/task", { mode: "navigate" });
    offline.handlers.fetch?.(e2.event);
    expect(await (await e2.responded)?.text()).toBe("cached:/index.html");
  });
});
