import { describe, expect, it } from "vitest";
import { GraphError, InstagramGraph } from "./instagram.ts";

const TOKEN = "tok-0123456789-abcdefghijklmnop";

function harness() {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(String(url));
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/insights")) return new Response(JSON.stringify({ data: [{ name: "reach", values: [{ value: 3 }], total_value: { value: 3 } }] }));
    return new Response(JSON.stringify({ id: "1", status_code: "FINISHED", permalink: "https://i.test/p/1", user_id: "9", username: "u", followers_count: 4 }));
  }) as unknown as typeof fetch;
  return { urls, fetchFn };
}

async function exercise(g: InstagramGraph) {
  await g.createImage("90", TOKEN, { imageUrl: "https://m/a.jpg", caption: "c" });
  await g.createCarouselItem("90", TOKEN, "https://m/a.jpg");
  await g.createCarousel("90", TOKEN, { children: ["1", "2"], caption: "c" });
  await g.createReel("90", TOKEN, { videoUrl: "https://m/a.mp4", caption: "c" });
  await g.status("cont", TOKEN);
  await g.publish("90", TOKEN, "cont");
  await g.permalink("med", TOKEN);
  await g.mediaInsights("med", TOKEN, ["reach"]);
  await g.accountInsights("90", TOKEN, { metrics: ["reach"], sinceSeconds: 1, untilSeconds: 2 });
  await g.followersCount("90", TOKEN);
  await g.me(TOKEN);
  await g.publishingLimit("90", TOKEN);
}

const PATHS = [
  "/v26.0/90/media", "/v26.0/90/media", "/v26.0/90/media", "/v26.0/90/media", "/v26.0/cont", "/v26.0/90/media_publish",
  "/v26.0/med", "/v26.0/med/insights", "/v26.0/90/insights", "/v26.0/90", "/v26.0/me", "/v26.0/90/content_publishing_limit",
];

describe("InstagramGraph host by login mode", () => {
  it("uses graph.instagram.com by default and for the instagram mode, with the same paths", async () => {
    const a = harness();
    await exercise(new InstagramGraph(a.fetchFn));
    const b = harness();
    await exercise(new InstagramGraph(b.fetchFn, undefined, "instagram"));
    for (const h of [a, b]) {
      expect(h.urls.map((u) => new URL(u).host)).toEqual(Array(PATHS.length).fill("graph.instagram.com"));
      expect(h.urls.map((u) => new URL(u).pathname)).toEqual(PATHS);
    }
  });

  it("uses graph.facebook.com for the unified mode, with the same paths and version", async () => {
    const h = harness();
    await exercise(new InstagramGraph(h.fetchFn, undefined, "unified"));
    expect(h.urls.map((u) => new URL(u).host)).toEqual(Array(PATHS.length).fill("graph.facebook.com"));
    expect(h.urls.map((u) => new URL(u).pathname)).toEqual(PATHS);
  });

  it("honors a custom version in both modes", async () => {
    const h = harness();
    await new InstagramGraph(h.fetchFn, "v99.0", "unified").status("c", TOKEN);
    await new InstagramGraph(h.fetchFn, "v99.0", "instagram").status("c", TOKEN);
    expect(h.urls.map((u) => new URL(u).origin + new URL(u).pathname)).toEqual(["https://graph.facebook.com/v99.0/c", "https://graph.instagram.com/v99.0/c"]);
  });

  it("keeps the token in the Authorization header, never in the URL", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ id: "1" }));
    }) as unknown as typeof fetch;
    await new InstagramGraph(fetchFn, undefined, "unified").createImage("90", TOKEN, { imageUrl: "https://m/a.jpg", caption: "c" });
    expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.url).not.toContain(TOKEN);
  });

  it("refreshes only on the instagram host and never calls Meta in the unified mode", async () => {
    const h = harness();
    await expect(new InstagramGraph(h.fetchFn, undefined, "unified").refresh(TOKEN)).rejects.toBeInstanceOf(GraphError);
    expect(h.urls).toEqual([]);
    const refreshing = (async (url: string) => (h.urls.push(String(url)), new Response(JSON.stringify({ access_token: "n".repeat(30), expires_in: 5000000 })))) as unknown as typeof fetch;
    await new InstagramGraph(refreshing).refresh(TOKEN);
    expect(new URL(h.urls[0]!).origin + new URL(h.urls[0]!).pathname).toBe("https://graph.instagram.com/refresh_access_token");
  });
});
