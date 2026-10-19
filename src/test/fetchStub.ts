import { vi } from "vitest";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: RecordedCall) => Response | Promise<Response> | "network-error";

/**
 * A fetch stand-in. Routes are matched on "METHOD /path"; an unmatched request
 * throws, so a screen that starts calling a new endpoint fails the test
 * instead of quietly rendering its error state.
 */
export function createFetchStub() {
  const routes: { key: string; handler: Handler }[] = [];
  const calls: RecordedCall[] = [];
  let failNext = 0;

  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const call: RecordedCall = {
      url,
      method,
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    if (failNext > 0) {
      failNext -= 1;
      throw new TypeError("Failed to fetch");
    }
    // Last registered route wins, so a test can override a default.
    const route = [...routes].reverse().find((r) => r.key === `${method} ${url}`);
    if (route === undefined) throw new Error(`fetchStub: unhandled ${method} ${url}`);
    const result = await route.handler(call);
    if (result === "network-error") throw new TypeError("Failed to fetch");
    return result;
  });

  return Object.assign(stub, {
    calls,
    on(key: string, handler: Handler | Response | "network-error") {
      routes.push({
        key,
        handler:
          typeof handler === "function" ? handler : typeof handler === "string" ? () => handler : () => handler.clone(),
      });
      return this;
    },
    /** The next n requests fail at the network level (no response at all). */
    failNext(n = 1) {
      failNext = n;
    },
    callsTo(key: string): RecordedCall[] {
      return calls.filter((c) => `${c.method} ${c.url}` === key);
    },
  });
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers });
}

const ERRORS = "https://errors.fulfillment-execution.warehouse-systems.dev";

export function problemResponse(status: number, slug: string, title: string, detail = "usecases: internal wording"): Response {
  return new Response(JSON.stringify({ type: `${ERRORS}/${slug}`, title, status, detail }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}
