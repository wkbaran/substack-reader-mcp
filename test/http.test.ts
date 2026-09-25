import { describe, expect, it } from "vitest";
import { AuthError, SubstackError, SubstackHttp } from "../src/substack/http.js";
import { fakeFetch, SID } from "./helpers.js";

const noSleep = async () => {};

async function rejection(p: Promise<unknown>): Promise<AuthError> {
  try {
    await p;
  } catch (e) {
    return e as AuthError;
  }
  throw new Error("expected the request to fail");
}

describe("SubstackHttp session scoping", () => {
  it("sends the session to substack.com and *.substack.com", async () => {
    const { fetch, requests } = fakeFetch({
      "https://substack.com/api/v1/x": { body: {} },
      "https://foo.substack.com/api/v1/y": { body: {} },
    });
    const http = new SubstackHttp({ sid: SID, fetch });
    await http.getJson("https://substack.com/api/v1/x");
    await http.getJson("https://foo.substack.com/api/v1/y");
    expect(requests.map((r) => r.cookie)).toEqual([`substack.sid=${SID}`, `substack.sid=${SID}`]);
  });

  it("does not send the session to unknown hosts, even look-alikes", async () => {
    const { fetch, requests } = fakeFetch({
      "https://evil.example/api": { body: {} },
      "https://notsubstack.com/api": { body: {} },
      "https://substack.com.evil.example/api": { body: {} },
    });
    const http = new SubstackHttp({ sid: SID, fetch });
    for (const url of Object.keys({ "https://evil.example/api": 1, "https://notsubstack.com/api": 1, "https://substack.com.evil.example/api": 1 })) {
      await http.getJson(url);
    }
    expect(requests.every((r) => r.cookie === null)).toBe(true);
  });

  it("gets custom domains their own session via Substack's sign-in handoff", async () => {
    const { fetch, requests } = fakeFetch({
      "https://substack.com/sign-in?redirect=%2F&for_pub=platformer": {
        status: 303,
        headers: { location: "https://www.platformer.news/api/v1/sign-in/local/complete?token=tok&redirect=%2F" },
      },
      "https://www.platformer.news/api/v1/sign-in/local/complete?token=tok&redirect=%2F": {
        status: 303,
        headers: { location: "/", "set-cookie": "connect.sid=s%3Acustom; Path=/; HttpOnly; Secure" },
      },
      "https://www.platformer.news/api/v1/archive": { body: [] },
    });
    const http = new SubstackHttp({ sid: SID, fetch });
    http.trustHost("www.platformer.news", "platformer");
    await http.getJson("https://www.platformer.news/api/v1/archive");
    await http.getJson("https://www.platformer.news/api/v1/archive");
    expect(requests.map((r) => [r.url.split("?")[0], r.cookie])).toEqual([
      ["https://substack.com/sign-in", `substack.sid=${SID}`],
      ["https://www.platformer.news/api/v1/sign-in/local/complete", null],
      ["https://www.platformer.news/api/v1/archive", "connect.sid=s%3Acustom"],
      // The handoff happens once per host, not per request.
      ["https://www.platformer.news/api/v1/archive", "connect.sid=s%3Acustom"],
    ]);
  });

  it("never follows a sign-in handoff to a different host", async () => {
    const { fetch, requests } = fakeFetch({
      "https://substack.com/sign-in?redirect=%2F&for_pub=platformer": {
        status: 303,
        headers: { location: "https://evil.example/api/v1/sign-in/local/complete?token=tok" },
      },
      "https://www.platformer.news/api/v1/archive": { body: [] },
    });
    const http = new SubstackHttp({ sid: SID, fetch });
    http.trustHost("www.platformer.news", "platformer");
    await http.getJson("https://www.platformer.news/api/v1/archive");
    expect(requests.some((r) => r.url.startsWith("https://evil.example"))).toBe(false);
    expect(requests.at(-1)).toMatchObject({ url: "https://www.platformer.news/api/v1/archive", cookie: null });
  });

  it("does not replay writes across redirects", async () => {
    const { fetch, requests } = fakeFetch({
      "https://pub.substack.com/api/v1/free": { status: 301, headers: { location: "https://custom.example/api/v1/free" } },
    });
    const http = new SubstackHttp({ sid: SID, fetch });
    await expect(http.sendJson("POST", "https://pub.substack.com/api/v1/free", { email: "x" })).rejects.toThrow(/HTTP 301/);
    expect(requests).toHaveLength(1);
  });

  it("drops the session when a redirect leaves Substack", async () => {
    const { fetch, requests } = fakeFetch({
      "https://pub.substack.com/api/v1/archive": { status: 301, headers: { location: "https://custom.example/api/v1/archive" } },
      "https://custom.example/api/v1/archive": { body: [] },
    });
    const http = new SubstackHttp({ sid: SID, fetch });
    await http.getJson("https://pub.substack.com/api/v1/archive");
    expect(requests.map((r) => [r.url, r.cookie])).toEqual([
      ["https://pub.substack.com/api/v1/archive", `substack.sid=${SID}`],
      ["https://custom.example/api/v1/archive", null],
    ]);
  });

  it("refuses to downgrade to http", async () => {
    const { fetch } = fakeFetch({
      "https://pub.substack.com/a": { status: 302, headers: { location: "http://pub.substack.com/a" } },
    });
    const http = new SubstackHttp({ sid: SID, fetch, maxRetries: 0 });
    await expect(http.getJson("https://pub.substack.com/a")).rejects.toThrow(/non-HTTPS/);
  });
});

describe("SubstackHttp errors", () => {
  it("reports a 401 with a session as expired", async () => {
    const { fetch } = fakeFetch({ "https://substack.com/api/v1/subscriptions": { status: 401 } });
    const http = new SubstackHttp({ sid: SID, fetch });
    const err = await rejection(http.getJson("https://substack.com/api/v1/subscriptions", { requireAuth: true }));
    expect(err).toBeInstanceOf(AuthError);
    expect(err.reason).toBe("expired");
    expect(err.message).toMatch(/substack-reader-mcp login/);
  });

  it("fails fast without a session when auth is required", async () => {
    const { fetch, requests } = fakeFetch({});
    const http = new SubstackHttp({ fetch });
    const err = await rejection(http.getJson("https://substack.com/api/v1/subscriptions", { requireAuth: true }));
    expect(err).toBeInstanceOf(AuthError);
    expect(err.reason).toBe("missing");
    expect(requests).toHaveLength(0);
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    let n = 0;
    const { fetch } = fakeFetch({
      "https://substack.com/x": () => (++n < 3 ? { status: n === 1 ? 429 : 503, headers: { "retry-after": "0" } } : { body: { ok: true } }),
    });
    const http = new SubstackHttp({ fetch, sleep: noSleep });
    expect(await http.getJson("https://substack.com/x")).toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it("surfaces Substack's error message", async () => {
    const { fetch } = fakeFetch({ "https://substack.com/x": { status: 400, body: { errors: [{ msg: "Bad thing" }] } } });
    const http = new SubstackHttp({ fetch, sleep: noSleep });
    const err = await rejection(http.getJson("https://substack.com/x"));
    expect(err).toBeInstanceOf(SubstackError);
    expect(err.message).toMatch(/HTTP 400.*Bad thing/);
  });
});
