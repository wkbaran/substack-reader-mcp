import type { FetchLike } from "../src/substack/http.js";

export interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  url: string;
  method: string;
  cookie: string | null;
  body?: unknown;
}

/**
 * A fake fetch keyed by full URL (or a function for dynamic routes). Records
 * every request with the Cookie header it carried so tests can assert on
 * where the session was — and wasn't — sent.
 */
export function fakeFetch(routes: Record<string, Route | ((req: RecordedRequest) => Route)>) {
  // Keys may be prefixed with a method ("DELETE https://...") to route writes separately.
  const requests: RecordedRequest[] = [];
  const impl: FetchLike = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const headers = new Headers(init?.headers);
    const req: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      cookie: headers.get("cookie"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    const route = routes[`${req.method} ${url}`] ?? routes[url];
    const r = typeof route === "function" ? route(req) : route;
    if (!r) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    const body = r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(body, {
      status: r.status ?? 200,
      headers: r.headers,
    });
  };
  return { fetch: impl, requests };
}

export const SID = "s%3Atest-session.signature";

/** Only answers 200 when the request carries the test session. */
export function authed(body: unknown): (req: RecordedRequest) => Route {
  return (req) =>
    req.cookie === `substack.sid=${SID}`
      ? { body }
      : { status: 401, body: { errors: [{ msg: "Please sign in" }] } };
}
