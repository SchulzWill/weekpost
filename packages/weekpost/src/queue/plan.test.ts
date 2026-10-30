import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/index.ts";
import type { WeekpostConfig } from "../config/schema.ts";
import { contentHash } from "../content/hash.ts";
import type { Post } from "../content/post.ts";
import { validateWeek } from "../content/week.ts";
import { captionFor } from "../lint/caption.ts";
import type { Manifest } from "../render/manifest.ts";
import { testConfig } from "../../test/fixtures/brand.ts";
import { localToUtc, planUpserts, planWeek, uploadsFor } from "./plan.ts";
import type { QueueRow } from "./types.ts";

const { config } = parseConfig(testConfig());

const link = (acc: string, c: string) => `https://hortaviva.example/?utm_source=instagram&utm_medium=social&utm_campaign=${acc}&utm_content=${c}`;
const YAML = {
  version: 1,
  posts: [
    {
      id: "2026-10-12-carousel-a", date: "2026-10-12", type: "carousel", accounts: ["en", "a"], times: { en: "12:00", a: "09:30" }, pillar: "tip",
      slides: [
        { kicker: { en: "Tip", a: "Dica" }, title: { en: "First", a: "Um" }, sub: { en: "One.", a: "Um." }, dark: true, image_prompt: "a leaf" },
        { kicker: { en: "Tip", a: "Dica" }, title: { en: "Second", a: "Dois" }, sub: { en: "Two.", a: "Dois." }, dark: false, image_prompt: "a pot" },
      ],
      caption: { en: "Caption.", a: "Legenda." }, cta: { en: "Link in bio.", a: "Link na bio." }, link: { en: link("en", "carousel-a"), a: link("a", "carousel-a") },
    },
    {
      id: "2026-10-13-story-a", date: "2026-10-13", type: "story", accounts: ["en"], times: { en: "08:00" }, pillar: "tip",
      story: { text: { en: "Story." }, link_utm_content: "story-a" },
      caption: { en: "Cap." }, cta: { en: "Go." }, link: { en: link("en", "story-a").replace("utm_campaign=en", "utm_campaign=en") },
    },
  ],
};

function load(cfg: WeekpostConfig = config) {
  const r = validateWeek("2026-W42", YAML, cfg);
  const errors = r.issues.filter((i) => i.level === "error");
  if (errors.length) throw new Error(JSON.stringify(errors));
  return r.posts;
}

const sha = (c: string) => c.repeat(64);

function manifestFor(posts: Post[], cfg: WeekpostConfig = config): { manifest: Manifest; hashes: Record<string, string> } {
  const hashes: Record<string, string> = {};
  const entries: Manifest["posts"] = posts.map((post) => {
    const accounts: Manifest["posts"][number]["accounts"] = {};
    for (const acc of post.accounts) {
      const n = post.type === "carousel" ? post.slides.length : 1;
      const publish = Array.from({ length: n }, (_, i) => `${post.id}/${acc}/${post.type === "carousel" ? `slide-${i + 1}` : post.type}.${post.type === "reel" ? "mp4" : "jpg"}`);
      const pin: Record<string, string> = {};
      publish.forEach((f, i) => (pin[f] = hashes[f] = sha("abcdef"[i % 6])));
      accounts[acc] = { files: publish, publish, sha256: pin, caption: post.type === "story" ? "Story.\n\n[Link sticker]" : captionFor(post, acc, cfg) };
    }
    return {
      id: post.id, type: post.type, date: post.date, times: post.times,
      timeZones: Object.fromEntries(post.accounts.map((a) => [a, cfg.accounts[a].timeZone])),
      contentHash: contentHash(post), accounts, coherence: [],
    };
  });
  return { manifest: { version: 1, generator: "t", week: "2026-W42", spentUsd: 0, budgetUsd: 1, warnings: [], posts: entries }, hashes };
}

const plan = (over: Partial<Parameters<typeof planWeek>[0]> = {}) => {
  const posts = load();
  const { manifest, hashes } = manifestFor(posts);
  return planWeek({ week: "2026-W42", posts, manifest, fileHashes: hashes, config, ...over });
};

describe("localToUtc", () => {
  it("converts wall-clock time to UTC in a northern zone across the autumn change", () => {
    // Lisbon: UTC+1 until 2026-10-25 01:00 UTC, then UTC+0.
    expect(localToUtc("2026-10-24", "12:00", "Europe/Lisbon")).toBe("2026-10-24T11:00:00.000Z");
    expect(localToUtc("2026-10-26", "12:00", "Europe/Lisbon")).toBe("2026-10-26T12:00:00.000Z");
  });
  it("converts in a southern zone across the spring change", () => {
    // Sydney: UTC+10 until 2026-10-04 02:00 local, then UTC+11.
    expect(localToUtc("2026-10-03", "12:00", "Australia/Sydney")).toBe("2026-10-03T02:00:00.000Z");
    expect(localToUtc("2026-10-05", "12:00", "Australia/Sydney")).toBe("2026-10-05T01:00:00.000Z");
  });
  it("handles a southern zone leaving DST in April and a northern one entering it in March", () => {
    expect(localToUtc("2026-04-04", "12:00", "Australia/Sydney")).toBe("2026-04-04T01:00:00.000Z"); // UTC+11 until 05 Apr
    expect(localToUtc("2026-04-06", "12:00", "Australia/Sydney")).toBe("2026-04-06T02:00:00.000Z"); // UTC+10
    expect(localToUtc("2026-03-28", "12:00", "Europe/Lisbon")).toBe("2026-03-28T12:00:00.000Z");
    expect(localToUtc("2026-03-30", "12:00", "Europe/Lisbon")).toBe("2026-03-30T11:00:00.000Z");
  });
  it("works for a zone without DST", () => {
    expect(localToUtc("2026-10-12", "09:00", "America/Sao_Paulo")).toBe("2026-10-12T12:00:00.000Z");
  });
});

describe("planWeek", () => {
  it("builds one row per post and account with the local time converted per account zone", () => {
    const { rows, uploads } = plan();
    const key = rows.map((r) => `${r.postId}/${r.account}`);
    expect(key).toEqual(["2026-10-12-carousel-a/en", "2026-10-12-carousel-a/a", "2026-10-13-story-a/en"]);
    expect(rows[0].publishAt).toBe("2026-10-12T11:00:00.000Z"); // London UTC+1
    expect(rows[1].publishAt).toBe("2026-10-12T08:30:00.000Z"); // Lisbon UTC+1
    expect(rows[0].media).toEqual([`2026-W42/2026-10-12-carousel-a/en/${sha("a")}.jpg`, `2026-W42/2026-10-12-carousel-a/en/${sha("b")}.jpg`]);
    expect(rows[0].contentHash).toBe(contentHash(load()[0]));
    expect(rows[0].caption).toContain("Caption.");
    expect(uploads).toHaveLength(5);
    expect(uploads[0]).toMatchObject({ from: "2026-10-12-carousel-a/en/slide-1.jpg", to: rows[0].media[0], contentType: "image/jpeg" });
  });

  it("enters Stories as manual, with the story text as the caption", () => {
    const story = plan().rows[2];
    expect(story.status).toBe("manual");
    expect(story.caption).toBe("Cap.\n\nGo.");
  });

  it("only enqueues the accounts in enqueue_accounts and reports the others", () => {
    const { rows, skippedAccounts } = plan({ enqueueAccounts: ["a"] });
    expect(rows.map((r) => r.account)).toEqual(["a"]);
    expect(skippedAccounts).toEqual(["2026-10-12-carousel-a/en", "2026-10-13-story-a/en"]);
  });

  it("does not require a manifest entry for a post whose accounts are all left out", () => {
    const posts = load();
    const { manifest, hashes } = manifestFor(posts);
    manifest.posts = manifest.posts.filter((p) => p.type !== "story");
    expect(() => planWeek({ week: "2026-W42", posts, manifest, fileHashes: hashes, config, enqueueAccounts: ["a"] })).not.toThrow();
  });

  const failing = (mutate: (m: Manifest, h: Record<string, string>) => void, expected: RegExp, over: Partial<Parameters<typeof planWeek>[0]> = {}) => {
    const posts = load();
    const { manifest, hashes } = manifestFor(posts);
    mutate(manifest, hashes);
    expect(() => planWeek({ week: "2026-W42", posts, manifest, fileHashes: hashes, config, ...over })).toThrow(expected);
  };

  it("fails when a file on disk differs from the manifest sha256", () => failing((_, h) => (h["2026-10-12-carousel-a/en/slide-1.jpg"] = sha("0")), /slide-1\.jpg: hash on disk differs/));
  it("fails when a published file is missing from disk", () => failing((_, h) => delete h["2026-10-12-carousel-a/a/slide-2.jpg"], /slide-2\.jpg: file is missing/));
  it("fails when the post contentHash differs from the YAML", () => failing((m) => (m.posts[0].contentHash = sha("9")), /carousel-a: the post changed after the preview/));
  it("fails when the manifest is for another week", () => failing((m) => (m.week = "2026-W41"), /manifest is for week 2026-W41/));
  it("fails when the post is missing from the manifest", () => failing((m) => m.posts.splice(1, 1), /story-a: missing from the manifest/));
  it("fails when the preview had a generation error", () => failing((m) => (m.posts[0].error = "boom"), /generation error: boom/));
  it("fails when the time zone in the manifest differs from the config", () => failing((m) => (m.posts[0].timeZones.a = "Europe/Madrid"), /a: time zone Europe\/Madrid in the manifest, Europe\/Lisbon in the config/));
  it("fails when the caption differs from the one the preview approved", () => failing((m) => (m.posts[0].accounts.en.caption = "other"), /en: caption differs/));
  it("fails when the carousel has fewer published files than slides", () => failing((m) => (m.posts[0].accounts.en.publish.pop(), void 0), /en: 1 published file\(s\), 2 slide\(s\)/));
  it("fails when a path does not belong to the post and account", () =>
    failing((m, h) => {
      const a = m.posts[0].accounts.en;
      a.publish[0] = "2026-10-12-carousel-a/a/slide-1.jpg";
      h[a.publish[0]] = a.sha256[a.publish[0]] = sha("a");
    }, /outside 2026-10-12-carousel-a\/en\//));
  it("reports every problem at once", () => {
    const posts = load();
    const { manifest, hashes } = manifestFor(posts);
    manifest.posts[0].contentHash = sha("9");
    delete hashes["2026-10-13-story-a/en/story.jpg"];
    let message = "";
    try {
      planWeek({ week: "2026-W42", posts, manifest, fileHashes: hashes, config });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/carousel-a[\s\S]*story\.jpg/);
  });

  it("requires a cover for a Reel whose first segment is a real photo, and publishes it with the cover", () => {
    const posts = load();
    const { manifest, hashes } = manifestFor(posts);
    const reel = { ...posts[0], id: "2026-10-12-reel-a", type: "reel", reel: { segments: [{ text: { en: "x" }, image_file: "p.jpg", seconds: 4 }], narration: { en: "n" } } } as unknown as Post;
    manifest.posts.push({ ...manifest.posts[0], id: reel.id, type: "reel", contentHash: contentHash(reel), accounts: { en: { files: [`${reel.id}/en/reel.mp4`], publish: [`${reel.id}/en/reel.mp4`], sha256: { [`${reel.id}/en/reel.mp4`]: sha("a") }, caption: captionFor(reel, "en", config) } } });
    hashes[`${reel.id}/en/reel.mp4`] = sha("a");
    const args = { week: "2026-W42", posts: [reel], manifest, fileHashes: hashes, config, enqueueAccounts: ["en"] };
    expect(() => planWeek(args)).toThrow(/en: the first segment is a real photo but the manifest has no cover/);
    const m = manifest.posts.at(-1)!.accounts.en;
    m.files.push(`${reel.id}/en/cover.jpg`); m.cover = `${reel.id}/en/cover.jpg`; m.sha256[m.cover] = hashes[m.cover] = sha("b");
    const out = planWeek(args);
    expect(out.rows[0].cover).toBe(`2026-W42/${reel.id}/en/${sha("b")}.jpg`);
    expect(out.rows[0].media).toEqual([`2026-W42/${reel.id}/en/${sha("a")}.mp4`]);
    expect(out.uploads.map((u) => u.contentType)).toEqual(["video/mp4", "image/jpeg"]);
  });
});

const existing = (over: Partial<QueueRow> = {}): QueueRow => {
  const row = plan().rows[0];
  return {
    ...row, status: "scheduled", attempts: 0, nextAttemptAt: null, claimedAt: null, containerId: null, mediaId: null, permalink: null,
    lastError: null, publishedAt: null, mediaPurgedAt: null, rescheduledAt: null, cover: row.cover ?? null, link: row.link ?? null, contentHash: row.contentHash ?? null,
    ...over,
  } as QueueRow;
};

describe("planWeek: media addressed by content", () => {
  it("names each object <week>/<post>/<account>/<sha256>.<ext>, so a changed file never overwrites an old one", () => {
    const { rows, uploads } = plan();
    const row = rows.find((r) => r.postId === "2026-10-12-carousel-a" && r.account === "en")!;
    expect(row.media).toEqual([`2026-W42/2026-10-12-carousel-a/en/${sha("a")}.jpg`, `2026-W42/2026-10-12-carousel-a/en/${sha("b")}.jpg`]);
    expect(uploads.filter((u) => u.to.includes("carousel-a/en")).map((u) => u.from)).toEqual(["2026-10-12-carousel-a/en/slide-1.jpg", "2026-10-12-carousel-a/en/slide-2.jpg"]);
  });
  it("uploads one object when two files of a post have the same bytes", () => {
    const posts = load();
    const { manifest, hashes } = manifestFor(posts);
    const m = manifest.posts[0].accounts.en;
    m.sha256[m.publish[1]] = hashes[m.publish[1]] = hashes[m.publish[0]];
    const { rows, uploads } = planWeek({ week: "2026-W42", posts, manifest, fileHashes: hashes, config });
    const row = rows.find((r) => r.postId === "2026-10-12-carousel-a" && r.account === "en")!;
    expect(row.media[0]).toBe(row.media[1]);
    expect(uploads.filter((u) => u.to === row.media[0])).toHaveLength(1);
  });
});

describe("planWeek: media hash", () => {
  const rowOf = (mutate: (m: Manifest, h: Record<string, string>) => void = () => {}) => {
    const posts = load();
    const { manifest, hashes } = manifestFor(posts);
    mutate(manifest, hashes);
    return planWeek({ week: "2026-W42", posts, manifest, fileHashes: hashes, config }).rows.find((r) => r.postId === "2026-10-12-carousel-a" && r.account === "en")!;
  };
  it("is a sha-256 of the approved files, in order", () => {
    expect(rowOf().mediaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rowOf().mediaHash).toBe(rowOf().mediaHash);
  });
  it("changes when one image changes, even though the YAML is the same", () => {
    const changed = rowOf((m, h) => {
      const f = m.posts[0].accounts.en.publish[1];
      m.posts[0].accounts.en.sha256[f] = h[f] = sha("9");
    });
    expect(changed.mediaHash).not.toBe(rowOf().mediaHash);
    expect(changed.contentHash).toBe(rowOf().contentHash);
  });
  it("depends on the order of the slides", () => {
    const swapped = rowOf((m, h) => {
      const [a, b] = m.posts[0].accounts.en.publish;
      m.posts[0].accounts.en.sha256[a] = h[a] = sha("b");
      m.posts[0].accounts.en.sha256[b] = h[b] = sha("a");
    });
    expect(swapped.mediaHash).not.toBe(rowOf().mediaHash);
  });
});

describe("planUpserts", () => {
  const rows = () => plan().rows;
  it("inserts rows that are not in the queue", () => {
    const r = planUpserts(rows(), []);
    expect(r.insert).toHaveLength(3);
    expect(r.update).toHaveLength(0);
  });
  it("skips a row with the same contentHash and publishAt, so the media already queued is not replaced", () => {
    const r = planUpserts(rows(), [existing()]);
    expect(r.skipped).toEqual([{ key: "2026-10-12-carousel-a/en", reason: "already queued, unchanged" }]);
    expect(r.insert).toHaveLength(2);
  });
  it("updates a still-editable row whose media changed under the same YAML (a second preview was approved)", () => {
    for (const status of ["scheduled", "failed"] as const) {
      const r = planUpserts(rows(), [existing({ status, mediaHash: sha("7") })]);
      expect(r.update.map((x) => x.postId)).toEqual(["2026-10-12-carousel-a"]);
      expect(r.update[0].mediaHash).toBe(rows()[0].mediaHash);
    }
  });
  it("updates a row written before the media hash existed (null)", () => {
    expect(planUpserts(rows(), [existing({ mediaHash: null })]).update).toHaveLength(1);
  });
  it("does not touch a publishing or published row whose media differs", () => {
    for (const status of ["publishing", "published"] as const) {
      const r = planUpserts(rows(), [existing({ status, mediaHash: sha("7") })]);
      expect(r.update).toHaveLength(0);
      expect(r.skipped[0].reason).toBe(`status is ${status}`);
    }
  });
  it("updates when the contentHash changes", () => {
    const r = planUpserts(rows(), [existing({ contentHash: sha("1") })]);
    expect(r.update.map((x) => x.postId)).toEqual(["2026-10-12-carousel-a"]);
  });
  it("updates when only the publish time changes", () => {
    const r = planUpserts(rows(), [existing({ publishAt: "2026-10-12T10:00:00Z" })]);
    expect(r.update).toHaveLength(1);
  });
  it("compares publishAt as an instant, not as text", () => {
    const r = planUpserts(rows(), [existing({ publishAt: "2026-10-12T11:00:00+00:00" })]);
    expect(r.skipped).toHaveLength(1);
  });
  it.each(["publishing", "published"] as const)("skips a %s row", (status) => {
    const r = planUpserts(rows(), [existing({ status, contentHash: sha("1") })]);
    expect(r.skipped[0].reason).toBe(`status is ${status}`);
    expect(r.update).toHaveLength(0);
  });
  it("skips a row the operator canceled, and says how to bring it back", () => {
    for (const canceledBy of ["operator", null, undefined] as const) {
      const r = planUpserts(rows(), [existing({ status: "canceled", canceledBy, contentHash: sha("1") })]);
      expect(r.update).toEqual([]);
      expect(r.skipped[0]).toMatchObject({ kind: "operator", reason: expect.stringContaining("canceled by the operator") });
      expect(r.skipped[0].reason).toContain("weekpost restore 2026-10-12-carousel-a --account=en");
    }
  });
  it("brings back a row the enqueue canceled when the approved YAML has it again, with the current content", () => {
    // The post left the YAML (canceled by the enqueue), and a later merge put it back, perhaps with another caption.
    const r = planUpserts(rows(), [existing({ status: "canceled", canceledBy: "enqueue", contentHash: sha("1"), mediaHash: sha("7") })]);
    expect(r.update).toHaveLength(1);
    expect(r.update[0]).toMatchObject({ postId: "2026-10-12-carousel-a", account: "en", revive: true, contentHash: rows()[0].contentHash, mediaHash: rows()[0].mediaHash });
    expect(r.skipped.find((s) => s.key === "2026-10-12-carousel-a/en")).toBeUndefined();
  });
  it("brings back a canceled Story as manual, and an identical canceled row too (the status is what changed)", () => {
    const story = existing({ postId: "2026-10-13-story-a", status: "canceled", canceledBy: "enqueue", contentHash: rows()[2].contentHash, mediaHash: rows()[2].mediaHash, publishAt: rows()[2].publishAt });
    const r = planUpserts(rows(), [story]);
    expect(r.update).toHaveLength(1);
    expect(r.update[0]).toMatchObject({ postId: "2026-10-13-story-a", status: "manual", revive: true });
  });
  it("does not bring back a row canceled by the enqueue of a newer commit", () => {
    const o = ["a", "b"].map((c) => c.repeat(40));
    const r = planUpserts(rows(), [existing({ status: "canceled", canceledBy: "enqueue", sourceCommit: o[1] })], undefined, { commit: o[0], isAncestor: (a, b) => a === b || (a === o[0] && b === o[1]) });
    expect(r.update).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ kind: "newer" });
  });
  it("keeps the time of a rescheduled row when the content changes", () => {
    const r = planUpserts(rows(), [existing({ rescheduledAt: "2026-10-10T00:00:00Z", publishAt: "2026-10-12T15:00:00Z", contentHash: sha("1") })]);
    expect(r.update[0].publishAt).toBe("2026-10-12T15:00:00Z");
  });
  it("skips a rescheduled row whose content did not change, even though the time differs", () => {
    const r = planUpserts(rows(), [existing({ rescheduledAt: "2026-10-10T00:00:00Z", publishAt: "2026-10-12T15:00:00Z" })]);
    expect(r.skipped).toHaveLength(1);
  });
  it("updates a failed row but keeps it failed (status is not part of the update)", () => {
    const r = planUpserts(rows(), [existing({ status: "failed", contentHash: sha("1") })]);
    expect(r.update).toHaveLength(1);
  });
  it("does not push a Story into a status other than manual", () => {
    const story = existing({ postId: "2026-10-13-story-a", status: "scheduled", contentHash: sha("1") });
    const r = planUpserts(rows(), [story]);
    expect(r.skipped.find((s) => s.key.includes("story"))?.reason).toBe("status is scheduled");
  });
});

describe("planUpserts: rows that left the approved plan", () => {
  const rows = () => plan().rows;
  const moved = (over: Partial<QueueRow> = {}) => existing({ postId: "2026-10-09-carousel-a", ...over });

  it("cancels the old row when a post changes its date (and so its id): one active row is left", () => {
    const r = planUpserts(rows(), [moved()], { postAccounts: { "2026-10-12-carousel-a": ["en", "pt"], "2026-10-13-story-a": ["en"] }, skippedAccounts: [] });
    expect(r.cancel).toEqual([{ key: "2026-10-09-carousel-a/en", reason: "the post is no longer in the week's YAML (removed, or its id/date changed)" }]);
    expect(r.insert.map((x) => x.postId)).not.toContain("2026-10-09-carousel-a");
  });
  it.each(["scheduled", "failed", "manual"] as const)("cancels an orphan %s row", (status) => {
    expect(planUpserts(rows(), [moved({ status })]).cancel).toHaveLength(1);
  });
  it.each(["publishing", "published", "canceled"] as const)("never touches an orphan %s row", (status) => {
    expect(planUpserts(rows(), [moved({ status })]).cancel).toEqual([]);
  });
  it("explains why: account left enqueue_accounts, or left the post", () => {
    const stale = [existing({ account: "pt" }), existing({ postId: "2026-10-13-story-a", account: "pt", status: "manual" })];
    const r = planUpserts(plan({ enqueueAccounts: ["en"] }).rows, stale, { postAccounts: { "2026-10-12-carousel-a": ["en"], "2026-10-13-story-a": ["en"] }, skippedAccounts: ["2026-10-12-carousel-a/pt"] });
    expect(r.cancel.map((c) => c.reason)).toEqual(["the account is not in enqueue_accounts", "the account is no longer in the post"]);
  });
});

// Stale runs: a re-run of an old merge, or two runs finishing out of order, read a YAML that lacks what a newer commit queued.
describe("planUpserts: rows written by a newer commit", () => {
  const rows = () => plan().rows;
  // Linear history W -> X -> Y. A run at X must not undo what Y queued.
  const ORDER = ["w", "x", "y"].map((c) => c.repeat(40));
  const [W, X, Y] = ORDER;
  const isAncestor = (a: string, b: string) => ORDER.indexOf(a) >= 0 && ORDER.indexOf(a) <= ORDER.indexOf(b);
  const at = (commit: string) => ({ commit, isAncestor });
  const newerPost = (over: Partial<QueueRow> = {}) => existing({ postId: "2026-10-14-added-by-y", ...over });

  it("does not cancel an orphan row that a newer commit queued (re-run of an old merge)", () => {
    const r = planUpserts(rows(), [newerPost({ sourceCommit: Y })], undefined, at(X));
    expect(r.cancel).toEqual([]);
    expect(r.skipped).toEqual([{ key: "2026-10-14-added-by-y/en", kind: "newer", reason: expect.stringContaining("queued by a newer commit") }]);
  });
  it("still cancels an orphan row written by the same or an older commit", () => {
    for (const sourceCommit of [W, X]) expect(planUpserts(rows(), [newerPost({ sourceCommit })], undefined, at(X)).cancel).toHaveLength(1);
  });
  it("cancels an orphan row that has no commit (written before migration 0003)", () => {
    expect(planUpserts(rows(), [newerPost({ sourceCommit: null })], undefined, at(X)).cancel).toHaveLength(1);
    expect(planUpserts(rows(), [newerPost()], undefined, at(X)).cancel).toHaveLength(1);
  });
  it("does not rewrite a row that a newer commit changed", () => {
    const r = planUpserts(rows(), [existing({ contentHash: sha("1"), sourceCommit: Y })], undefined, at(X));
    expect(r.update).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ kind: "newer" });
  });
  it("updates a row written by an older commit", () => {
    expect(planUpserts(rows(), [existing({ contentHash: sha("1"), sourceCommit: W })], undefined, at(X)).update).toHaveLength(1);
  });
  it("keeps saying 'unchanged' for an identical row, whatever commit wrote it", () => {
    expect(planUpserts(rows(), [existing({ sourceCommit: Y })], undefined, at(X)).skipped[0].reason).toBe("already queued, unchanged");
  });
  it("two runs out of order: the old one touches nothing the newer one queued", () => {
    // Y queued {carousel-a/en (changed), added-by-y}; the run for X reads the older YAML.
    const queued = [existing({ contentHash: sha("1"), sourceCommit: Y }), newerPost({ sourceCommit: Y })];
    const r = planUpserts(rows(), queued, undefined, at(X));
    expect(r.cancel).toEqual([]);
    expect(r.update).toEqual([]);
    expect(r.skipped.filter((s) => s.kind === "newer")).toHaveLength(2);
  });
  it("treats a commit the checkout does not know as newer (the safe side)", () => {
    const r = planUpserts(rows(), [newerPost({ sourceCommit: "f".repeat(40) })], undefined, { commit: X, isAncestor });
    expect(r.cancel).toEqual([]);
  });
});

// A post whose time has passed is not queued (it would go out at once, in a burst): it is skipped with a warning
// instead of failing the run, because one such post must not hold the rest of the week back.
describe("planUpserts: publish times in the past", () => {
  const rows = () => plan().rows; // carousel en 11:00Z, carousel a 08:30Z (12 Oct), Story en 07:00Z (13 Oct)
  const NOW = new Date("2026-10-12T20:00:00Z"); // the two carousels are past, the Story is not
  const late = { now: NOW, allowPast: false };
  const keys = (xs: { key: string }[]) => xs.map((x) => x.key);

  it("skips a new post whose time is past, with the reason, and inserts the others", () => {
    const r = planUpserts(rows(), [], undefined, late);
    expect(r.insert.map((x) => `${x.postId}/${x.account}`)).toEqual(["2026-10-13-story-a/en"]);
    expect(r.skipped).toEqual([
      { key: "2026-10-12-carousel-a/en", kind: "past", reason: expect.stringContaining("is in the past") },
      { key: "2026-10-12-carousel-a/a", kind: "past", reason: expect.stringContaining("--allow-past") },
    ]);
  });
  it("--allow-past queues it with its own time", () => {
    const r = planUpserts(rows(), [], undefined, { ...late, allowPast: true });
    expect(r.insert).toHaveLength(3);
    expect(r.skipped).toEqual([]);
  });
  it("never applies the rule to a Story (published by hand)", () => {
    const r = planUpserts(rows(), [], undefined, { now: new Date("2027-01-01T00:00:00Z"), allowPast: false });
    expect(r.insert.map((x) => x.postId)).toEqual(["2026-10-13-story-a"]);
    const story = existing({ postId: "2026-10-13-story-a", status: "manual", contentHash: sha("1"), publishAt: "2026-10-13T07:00:00.000Z" });
    expect(planUpserts(rows(), [story], undefined, { now: new Date("2027-01-01T00:00:00Z"), allowPast: false }).update.map((x) => x.postId)).toEqual(["2026-10-13-story-a"]);
  });
  it("fills in the media hash of a row written before it existed, even when its time is past", () => {
    const r = planUpserts(rows(), [existing({ mediaHash: null })], undefined, late);
    expect(r.update.map((x) => x.postId)).toEqual(["2026-10-12-carousel-a"]);
    expect(keys(r.skipped)).not.toContain("2026-10-12-carousel-a/en");
  });
  it("skips an update of a past row whose content changed, but not one whose time is in the future", () => {
    const changed = planUpserts(rows(), [existing({ status: "failed", contentHash: sha("1") })], undefined, late);
    expect(changed.update).toEqual([]);
    expect(changed.skipped[0]).toMatchObject({ key: "2026-10-12-carousel-a/en", kind: "past" });
    const future = planUpserts(rows(), [existing({ status: "failed", contentHash: sha("1") })], undefined, { now: new Date("2026-10-01T00:00:00Z"), allowPast: false });
    expect(future.update).toHaveLength(1);
  });
  it("uses the time a rescheduled row keeps, not the one in the YAML", () => {
    const kept = existing({ rescheduledAt: "2026-10-10T00:00:00Z", publishAt: "2026-10-20T10:00:00.000Z", contentHash: sha("1") });
    expect(planUpserts(rows(), [kept], undefined, late).update[0].publishAt).toBe("2026-10-20T10:00:00.000Z");
  });
  it("does not bring back a canceled row whose time is past", () => {
    const r = planUpserts(rows(), [existing({ status: "canceled", canceledBy: "enqueue" })], undefined, late);
    expect(r.update).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ kind: "past" });
  });
  it("applies no rule when the caller gives no clock", () => {
    expect(planUpserts(rows(), []).insert).toHaveLength(3);
  });
});

describe("uploadsFor", () => {
  it("uploads only the media of rows that will be written", () => {
    const { rows, uploads } = plan();
    const r = planUpserts(rows, [existing()]);
    const sent = uploadsFor(uploads, r);
    expect(sent.some((u) => u.to.includes("carousel-a/en"))).toBe(false);
    expect(sent.some((u) => u.to.includes("carousel-a/a"))).toBe(true);
  });
});
