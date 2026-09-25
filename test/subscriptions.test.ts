import { describe, expect, it } from "vitest";
import { matchSubscription, paidSignal, parsePreloads, SubstackClient, type Subscription } from "../src/substack/api.js";
import { SubstackError, SubstackHttp } from "../src/substack/http.js";
import { authed, fakeFetch, SID, type Route } from "./helpers.js";

const FREE = { membership_state: "free_signup", is_subscribed: false, stripe_subscription_id: null, is_founding: false, expiry: null };
const PAID = { membership_state: "subscribed", is_subscribed: true, stripe_subscription_id: "sub_123", is_founding: false, expiry: 1793655729000 };

const PUBS = {
  10: { id: 10, name: "Free Pub", subdomain: "freepub" },
  20: { id: 20, name: "Paid Pub", subdomain: "paidpub" },
  30: { id: 30, name: "New Pub", subdomain: "newpub" },
  40: { id: 40, name: "Free Pub Weekly", subdomain: "freeweekly" },
} as const;

function preloadsHtml(data: unknown): string {
  return `<html><script>window._preloads        = JSON.parse(${JSON.stringify(JSON.stringify(data))})</script></html>`;
}

/** A tiny stateful Substack: subscribing and unsubscribing really change what later reads return. */
function fakeSubstack(initial: Record<number, typeof FREE | typeof PAID>) {
  const state = new Map(Object.entries(initial).map(([id, s]) => [Number(id), s]));
  const routes: Record<string, Route | ((req: { cookie: string | null; body?: unknown }) => Route)> = {
    "https://substack.com/api/v1/user/profile/self": (req) =>
      authed({
        id: 1,
        subscriptions: [...state].map(([id, s]) => ({ membership_state: s.membership_state, publication: PUBS[id as keyof typeof PUBS] })),
      })(req as never),
    "https://substack.com/settings": { body: preloadsHtml({ user: { id: 1, email: "reader@example.com" } }) },
  };
  for (const [id, pub] of Object.entries(PUBS)) {
    const base = `https://${pub.subdomain}.substack.com`;
    routes[`https://substack.com/api/v1/subscription/${id}`] = () =>
      state.has(Number(id)) ? { body: { subscription: { membership_state: state.get(Number(id))!.membership_state } } } : { status: 404, body: { error: "Subscription not found" } };
    routes[`GET ${base}/api/v1/subscription`] = () => (state.has(Number(id)) ? { body: state.get(Number(id)) } : { status: 404 });
    routes[`DELETE ${base}/api/v1/free`] = () => {
      state.delete(Number(id));
      return { body: {} };
    };
    routes[`POST ${base}/api/v1/free`] = () => {
      state.set(Number(id), FREE);
      return { body: { requires_confirmation: false } };
    };
    routes[`${base}/`] = { body: preloadsHtml({ pub: { ...pub, custom_domain: null } }) };
  }
  const { fetch, requests } = fakeFetch(routes as never);
  const client = new SubstackClient(new SubstackHttp({ sid: SID, fetch, sleep: async () => {} }));
  return { client, state, requests };
}

describe("unsubscribe", () => {
  it("removes a free subscription and verifies it's gone", async () => {
    const { client, state, requests } = fakeSubstack({ 10: FREE, 20: PAID });
    expect(await client.unsubscribe("Free Pub")).toEqual({ result: "unsubscribed", publication: "Free Pub", url: "https://freepub.substack.com" });
    expect(state.has(10)).toBe(false);
    const deletes = requests.filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => [r.url, r.body])).toEqual([["https://freepub.substack.com/api/v1/free", { publication_id: 10, source: "account" }]]);
  });

  it("refuses paid subscriptions without sending a DELETE", async () => {
    const { client, state, requests } = fakeSubstack({ 20: PAID });
    await expect(client.unsubscribe("paidpub")).rejects.toThrow(/Refusing to unsubscribe from Paid Pub: it's a paid subscription/);
    expect(state.has(20)).toBe(true);
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("refuses when the publication can't confirm the subscription is free", async () => {
    const { client, requests } = fakeSubstack({ 10: FREE });
    const c = client as unknown as { http: SubstackHttp };
    // Simulate the per-publication check failing.
    const original = c.http.getJson.bind(c.http);
    c.http.getJson = (async (url: string, opts?: object) => {
      if (url === "https://freepub.substack.com/api/v1/subscription") throw new Error("boom");
      return original(url, opts);
    }) as typeof c.http.getJson;
    await expect(client.unsubscribe("Free Pub")).rejects.toThrow(/Couldn't verify .* nothing was changed/);
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("asks for clarification when a name is ambiguous", async () => {
    const { client, requests } = fakeSubstack({ 10: FREE, 40: FREE });
    await expect(client.unsubscribe("free")).rejects.toThrow(/matches several subscriptions \(Free Pub, Free Pub Weekly\)/);
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("errors on publications you're not subscribed to", async () => {
    const { client } = fakeSubstack({ 10: FREE });
    await expect(client.unsubscribe("newpub")).rejects.toThrow(/not subscribed to anything matching "newpub"/);
  });
});

describe("subscribe", () => {
  it("free-subscribes with the account email and verifies", async () => {
    const { client, state, requests } = fakeSubstack({});
    expect(await client.subscribe("newpub")).toEqual({
      result: "subscribed",
      publication: "New Pub",
      url: "https://newpub.substack.com",
      membership: "free_signup",
    });
    expect(state.get(30)).toBe(FREE);
    const post = requests.find((r) => r.method === "POST")!;
    expect(post.url).toBe("https://newpub.substack.com/api/v1/free");
    expect(post.body).toMatchObject({ email: "reader@example.com" });
  });

  it("treats a redirect from the subscribe form as accepted, then verifies", async () => {
    const { client, state } = fakeSubstack({});
    const c = client as unknown as { http: { sendJson: SubstackHttp["sendJson"] } };
    const original = c.http.sendJson.bind(c.http);
    c.http.sendJson = (async (method: "POST" | "DELETE", url: string, body: unknown, opts?: object) => {
      await original(method, url, body, opts); // performs the subscription
      throw new SubstackError(`Substack returned HTTP 302 for ${url}`, 302, url);
    }) as typeof c.http.sendJson;
    expect(await client.subscribe("newpub")).toMatchObject({ result: "subscribed" });
    expect(state.has(30)).toBe(true);
  });

  it("leaves existing subscriptions alone (including paid ones)", async () => {
    const { client, requests } = fakeSubstack({ 20: PAID });
    expect(await client.subscribe("paidpub")).toMatchObject({ result: "already_subscribed", membership: "subscribed" });
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });
});

describe("helpers", () => {
  it("paidSignal only clears subscriptions with every free signal", () => {
    expect(paidSignal(FREE)).toBeNull();
    expect(paidSignal(PAID)).toMatch(/membership/);
    expect(paidSignal({ ...FREE, stripe_subscription_id: "sub_1" })).toMatch(/Stripe/);
    expect(paidSignal({ ...FREE, is_subscribed: true })).toMatch(/paid subscriber/);
    expect(paidSignal({ ...FREE, is_founding: true })).toMatch(/founding/);
    expect(paidSignal({ ...FREE, expiry: 123 })).toMatch(/paid-through/);
    expect(paidSignal({})).toMatch(/unknown/);
  });

  it("matchSubscription prefers exact matches over partial ones", () => {
    const subs = [
      { publicationId: 1, name: "Latent.Space", url: "https://www.latent.space", subdomain: "swyx" },
      { publicationId: 2, name: "The Substack Post", url: "https://post.substack.com", subdomain: "post" },
      { publicationId: 3, name: "On Substack", url: "https://on.substack.com", subdomain: "on" },
    ] satisfies Subscription[];
    expect(matchSubscription("swyx", subs).map((s) => s.publicationId)).toEqual([1]);
    expect(matchSubscription("https://www.latent.space/", subs).map((s) => s.publicationId)).toEqual([1]);
    expect(matchSubscription("on", subs).map((s) => s.publicationId)).toEqual([3]);
    expect(matchSubscription("substack", subs).map((s) => s.publicationId)).toEqual([2, 3]);
  });

  it("parsePreloads reads the embedded page data", () => {
    expect(parsePreloads(preloadsHtml({ user: { email: "a@b.c" } }))).toEqual({ user: { email: "a@b.c" } });
    expect(parsePreloads("<html></html>")).toBeNull();
  });
});
