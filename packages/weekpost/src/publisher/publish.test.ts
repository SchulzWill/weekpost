import { describe, expect, it } from "vitest";
import { FakeDb, FakeMeta, FakeStorage, IG_USER, post, token, TOKEN } from "../../test/publisher-fakes.ts";
import { processPost, retryDelaySeconds, type Outcome } from "./publish.ts";

function setup(rows: ReturnType<typeof post>[] = []) {
  const db = new FakeDb();
  const meta = new FakeMeta();
  const storage = new FakeStorage();
  db.rows = rows;
  db.tokensRows = [token("main"), token("second")];
  const logs: string[] = [];
  const deps = { db, storage, graph: meta.graph(), sleep: async () => {}, log: (e: string, d: Record<string, unknown>) => logs.push(`${e} ${JSON.stringify(d)}`) };
  // What the run does for the publisher: claim, then one post at a time.
  const run = async (limit = 2) => {
    const claimed = await db.claim(limit);
    const outcomes: Outcome[] = [];
    for (const p of claimed) outcomes.push(await processPost(p, db.tokensRows.find((t) => t.account === p.account), deps));
    return { claimed: claimed.length, outcomes };
  };
  return { db, meta, storage, deps, logs, run };
}

describe("access token transport", () => {
  it("publishing calls send the token in the Authorization header, never in the URL or the body", async () => {
    const { meta, run } = setup([post({ postId: "a", media: ["2026-W42/a/main/slide-01.jpg"] })]);
    await run();
    expect(meta.calls.length).toBeGreaterThanOrEqual(4); // container, status, publish, permalink
    for (const c of meta.calls) {
      expect(c.authorization, c.path).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
      expect(c.url).not.toContain("access_token");
      expect(c.params.access_token).toBeUndefined();
    }
  });

  it("the token refresh keeps the documented query parameter (the docs do not show a header for it)", async () => {
    const meta = new FakeMeta();
    await meta.graph().refresh(TOKEN);
    expect(meta.calls[0]!.params.access_token).toBe(TOKEN);
  });
});

describe("publishing by type", () => {
  it("single image: creates the container, waits for FINISHED, publishes and records media id and permalink", async () => {
    const { db, meta, run } = setup([post({ postId: "a", media: ["2026-W42/a/main/slide-01.jpg"] })]);
    await run();
    const r = db.rows[0]!;
    expect(r.status).toBe("published");
    expect(r.mediaId).toBe("media-1");
    expect(r.permalink).toBe("https://www.instagram.com/p/media-1/");
    expect(meta.calls.find((c) => c.path.endsWith("/media"))!.params.image_url).toBe("https://signed.example/2026-W42/a/main/slide-01.jpg?token=abc");
    expect(meta.calls[0]!.path).toBe(`/v26.0/${IG_USER}/media`);
  });

  it("carousel of 10: one child per image (is_carousel_item) and a parent container with the 10 children in order", async () => {
    const media = Array.from({ length: 10 }, (_, i) => `2026-W42/c/main/slide-${String(i + 1).padStart(2, "0")}.jpg`);
    const { db, meta, storage, run } = setup([post({ postId: "c", media })]);
    await run();
    const creates = meta.calls.filter((c) => c.path.endsWith("/media"));
    expect(creates).toHaveLength(11);
    expect(creates.slice(0, 10).every((c) => c.params.is_carousel_item === "true")).toBe(true);
    const parent = creates[10]!;
    expect(parent.params.media_type).toBe("CAROUSEL");
    expect(parent.params.children).toBe(Array.from({ length: 10 }, (_, i) => `cont-${i + 1}`).join(","));
    expect(parent.params.caption).toBe("Caption");
    expect(db.rows[0]!.status).toBe("published");
    expect(meta.publishCount).toBe(1);
    expect(storage.signed).toHaveLength(10);
  });

  it("Reel: media_type REELS with the signed video and cover", async () => {
    const { db, meta, run } = setup([post({ postId: "r", type: "reel", media: ["2026-W42/r/main/video.mp4"], cover: "2026-W42/r/main/cover.jpg" })]);
    await run();
    const c = meta.calls.find((x) => x.path.endsWith("/media"))!;
    expect(c.params).toMatchObject({ media_type: "REELS", video_url: "https://signed.example/2026-W42/r/main/video.mp4?token=abc", cover_url: "https://signed.example/2026-W42/r/main/cover.jpg?token=abc" });
    expect(db.rows[0]!.status).toBe("published");
  });

  it("a URL in the media is an error (bucket paths only), without touching Meta", async () => {
    const { db, meta, run } = setup([post({ postId: "u", media: ["https://cdn.example/a.jpg"] })]);
    await run();
    expect(meta.calls).toHaveLength(0);
    expect(db.rows[0]!.lastError).toContain("invalid media path");
  });
});

describe("Reel still processing", () => {
  it("not done in this run: keeps the container, goes back to the queue without spending an attempt; the next run resumes without a new container", async () => {
    const { db, meta, storage, run } = setup([post({ postId: "r", type: "reel", media: ["2026-W42/r/main/video.mp4"] })]);
    meta.defaultScript = ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    const out1 = await run();
    expect(out1.outcomes).toEqual(["pending"]);
    const r = db.rows[0]!;
    expect(r.status).toBe("scheduled");
    expect(r.containerId).toBe("cont-1");
    expect(r.attempts).toBe(0);
    expect(meta.count(/\/media$/)).toBe(1);
    expect(meta.count(/media_publish/)).toBe(0);

    r.nextAttemptMs = 0; // the wait is over
    const out2 = await run();
    expect(out2.outcomes).toEqual(["published"]);
    expect(meta.count(/\/media$/)).toBe(1); // no new container
    expect(meta.publishCount).toBe(1);
    expect(storage.signed).toHaveLength(1); // did not sign again: the container already holds the media
  });

  it("container ERROR: clears the container id and counts the attempt; the next one creates another", async () => {
    const { db, meta, run } = setup([post({ postId: "r", type: "reel", media: ["2026-W42/r/main/video.mp4"] })]);
    meta.defaultScript = ["ERROR"];
    await run();
    const r = db.rows[0]!;
    expect(r).toMatchObject({ status: "scheduled", containerId: null, attempts: 1 });
    expect(r.lastError).toContain("ERROR");
    meta.defaultScript = ["FINISHED"];
    r.nextAttemptMs = 0;
    await run();
    expect(db.rows[0]!.status).toBe("published");
    expect(meta.count(/\/media$/)).toBe(2);
  });
});

describe("never publishes twice", () => {
  it("two concurrent runs: the post goes out once", async () => {
    const { db, meta, run } = setup([post({ postId: "a", media: ["2026-W42/a/main/slide-01.jpg"] })]);
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(meta.publishCount).toBe(1);
    expect(db.rows[0]!.status).toBe("published");
  });

  it("media id already recorded: only closes the state, without calling Meta", async () => {
    const { db, meta, run } = setup([post({ postId: "a", mediaId: "media-9", permalink: "https://i/p/9" })]);
    await run();
    expect(meta.calls).toHaveLength(0);
    expect(db.rows[0]).toMatchObject({ status: "published", mediaId: "media-9" });
  });

  it("container id recorded: reuses it and creates no other", async () => {
    const { db, meta, run } = setup([post({ postId: "a", containerId: "cont-77" })]);
    meta.containers.set("cont-77", { script: ["FINISHED"] });
    await run();
    expect(meta.count(/\/media$/)).toBe(0);
    expect(meta.calls.find((c) => c.path.endsWith("media_publish"))!.params.creation_id).toBe("cont-77");
    expect(db.rows[0]!.status).toBe("published");
  });

  it("container already PUBLISHED (the record failed earlier): closes without publishing again", async () => {
    const { db, meta, run } = setup([post({ postId: "a", containerId: "cont-77" })]);
    meta.containers.set("cont-77", { script: ["PUBLISHED"], published: "media-5" });
    await run();
    expect(meta.publishCount).toBe(0);
    expect(db.rows[0]).toMatchObject({ status: "published", containerId: "cont-77" });
  });

  it("a failure recording `published` does not become a new publish: the post stays in publishing", async () => {
    const { db, meta, deps, logs } = setup([post({ postId: "a", media: ["2026-W42/a/main/slide-01.jpg"] })]);
    db.markPublished = async () => { throw new Error("database down"); };
    const [claimed] = await db.claim(1);
    expect(await processPost(claimed!, token("main"), deps)).toBe("failed");
    expect(db.rows[0]!.status).toBe("publishing");
    expect(meta.publishCount).toBe(1);
    expect(logs.some((l) => l.startsWith("ERROR_record_published"))).toBe(true);
  });
});

describe("failures", () => {
  it("3 failures in a row: reschedules with a growing wait on the first two and fails on the third, with a readable error", async () => {
    const { db, meta, run } = setup([post({ postId: "a", media: ["2026-W42/a/main/slide-01.jpg"] })]);
    const states: string[] = [];
    for (let i = 0; i < 3; i++) {
      meta.failNext = { match: /\/media$/, body: { error: { message: "Invalid parameter", code: 100, error_subcode: 2207052, error_user_msg: "The media could not be fetched" } } };
      db.rows[0]!.nextAttemptMs = 0;
      await run();
      states.push(db.rows[0]!.status);
    }
    expect(states).toEqual(["scheduled", "scheduled", "failed"]);
    expect(db.rows[0]!.lastError).toBe("Instagram 100/2207052: The media could not be fetched");
    expect(meta.publishCount).toBe(0);
    expect([1, 2, 3].map(retryDelaySeconds)).toEqual([300, 600, 1200]);
  });

  it("an account without a token fails with a clear message, without touching Meta", async () => {
    const { db, meta, run } = setup([post({ postId: "a", account: "other" })]);
    await run();
    expect(db.rows[0]!.lastError).toContain("no Instagram token for account other");
    expect(meta.calls).toHaveLength(0);
  });

  it("a media path with .. is refused before signing", async () => {
    const { db, storage, run } = setup([post({ postId: "a", media: ["../other/secret.jpg"] })]);
    await run();
    expect(storage.signed).toEqual([]);
    expect(db.rows[0]!.lastError).toContain("invalid media path");
  });

  it("the token never shows in lastError or in a log, even if a network error carries it", async () => {
    const { db, logs, deps } = setup([post({ postId: "a", media: ["2026-W42/a/main/slide-01.jpg"] })]);
    const failing = (async () => { throw new Error(`failed on ?access_token=${TOKEN}`); }) as typeof fetch;
    const graph = new (deps.graph.constructor as new (f: typeof fetch) => typeof deps.graph)(failing);
    const [claimed] = await db.claim(1);
    await processPost(claimed!, token("main"), { ...deps, graph });
    expect(db.rows[0]!.lastError).toContain("[token]");
    expect(JSON.stringify(db.rows) + logs.join("\n")).not.toContain(TOKEN);
  });

  it("a Story is never published by the API", async () => {
    const { db, meta, deps } = setup([post({ postId: "s", type: "story" })]);
    const [claimed] = await db.claim(1);
    expect(await processPost(claimed!, token("main"), deps)).toBe("retry");
    expect(meta.calls).toHaveLength(0);
    expect(db.rows[0]!.lastError).toContain("published by hand");
  });
});
