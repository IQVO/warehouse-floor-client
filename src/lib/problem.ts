/**
 * RFC 7807 problem details, as every fulfillment-execution error is returned
 * (Content-Type: application/problem+json).
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

/** The last path segment of the problem `type` URI, e.g. "task-not-claimed". */
export function problemCode(problem: Problem): string {
  const trimmed = problem.type.replace(/[/#]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("#"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Builds a Problem from an error response. A body that is not problem JSON --
 * an HTML page from a gateway, an empty 502, a proxy's text -- still yields a
 * Problem (type "about:blank"), so callers never branch on "was it JSON".
 */
export function parseProblem(status: number, statusText: string, body: string): Problem {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value === "object" && value !== null) {
      const type: unknown = Reflect.get(value, "type");
      const title: unknown = Reflect.get(value, "title");
      if (typeof type === "string" && typeof title === "string") {
        const detail: unknown = Reflect.get(value, "detail");
        const instance: unknown = Reflect.get(value, "instance");
        const code: unknown = Reflect.get(value, "status");
        return {
          type,
          title,
          status: typeof code === "number" ? code : status,
          ...(typeof detail === "string" ? { detail } : {}),
          ...(typeof instance === "string" ? { instance } : {}),
        };
      }
    }
  } catch {
    // not JSON; fall through
  }
  return { type: "about:blank", title: statusText || "Unexpected response", status };
}
