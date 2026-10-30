import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runEnqueue } from "../src/cli/enqueue.ts";
import { runGenerate } from "../src/cli/generate.ts";
import type { NewRow, OperatorDb, QueueRow } from "../src/queue/types.ts";
import { testConfig, testProject } from "./fixtures/brand.ts";

const link = (c: string) => `https://hortaviva.example/?utm_source=instagram&utm_medium=social&utm_campaign=en&utm_content=${c}`;
const WEEK = `version: 1
posts:
  - id: 2026-10-12-carousel-a
    date: 2026-10-12
    type: carousel
    accounts: [en]
    times: { en: "12:00" }
    pillar: tip
    slides:
      - { kicker: { en: "Tip" }, title: { en: "First" }, sub: { en: "One." }, dark: true, image_prompt: "a leaf" }
      - { kicker: { en: "Tip" }, title: { en: "Second" }, sub: { en: "Two." }, dark: false, image_prompt: "a pot" }
    caption: { en: "Caption." }
    cta: { en: "Link in bio." }
    link: { en: "${link("carousel-a")}" }
  - id: 2026-10-13-story-a
    date: 2026-10-13
    type: story
    accounts: [en]
    times: { en: "08:00" }
    pillar: tip
    story: { text: { en: "Story." }, link_utm_content: "story-a" }
    caption: { en: "Cap." }
    cta: { en: "Go." }
    link: { en: "${link("story-a")}" }
`;

const capture = () => {
  const lines: string[] = [];
  return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) } };
};

const before = () => new Date("2026-10-01T00:00:00Z"); // the fixture posts are on 12 and 13 October

function fakeQueue(existing: QueueRow[] = []) {
  const inserted: NewRow[] = [];
  const updated: string[] = [];
  const revived: string[] = [];
  const puts: string[] = [];
  const canceled: string[] = [];
  const db = {
    rows: async () => existing,
    cancel: async (k: { postId: string; account: string }, by?: string, _stamp?: unknown) => void canceled.push(`${k.postId}/${k.account}${by === "enqueue" ? "" : ` by ${by}`}`),
    insert: async (rows: NewRow[]) => void inserted.push(...rows),
    updateContent: async (k: { postId: string; account: string }, _c?: unknown, o?: { revive?: boolean }) => void (o?.revive ? revived : updated).push(`${k.postId}/${k.account}`),
  } as unknown as OperatorDb;
  const storage = { put: async (p: string) => void puts.push(p), sign: async () => [], remove: async () => {}, ensureBucket: async () => {} };
  return { db, storage, inserted, updated, revived, puts, canceled };
}

describe("weekpost enqueue", () => {
  let dir: string;
  const weeksFile = () => join(dir, "weeks.txt");
  beforeAll(async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network is off in this test")));
    dir = testProject();
    const input = testConfig();
    input.accounts = { en: input.accounts.en };
    writeFileSync(join(dir, "weekpost.config.ts"), `export default ${JSON.stringify(input)};\n`);
    mkdirSync(join(dir, "content", "2026-W42"), { recursive: true });
    writeFileSync(join(dir, "content", "2026-W42", "posts.yaml"), WEEK);
    writeFileSync(weeksFile(), "2026-W42\n");
    expect(await runGenerate(["2026-W42", "--fake-media"], capture().out, dir)).toBe(0);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const args = (...extra: string[]) => ["out", `--weeks=${weeksFile()}`, ...extra];

  it("prints usage without the artifact directory or the weeks file", async () => {
    const { lines, out } = capture();
    expect(await runEnqueue([], out, dir)).toBe(2);
    expect(lines[0]).toContain("usage: weekpost enqueue");
  });

  it("--dry-run plans the week without the Supabase env and writes nothing", async () => {
    const { lines, out } = capture();
    expect(await runEnqueue(args("--dry-run"), out, dir, { env: {} })).toBe(0);
    expect(lines.join("\n")).toMatch(/2026-10-12-carousel-a\/en carousel 2026-10-12T11:00:00.000Z scheduled 2 file/);
    expect(lines.join("\n")).toMatch(/2026-10-13-story-a\/en story .* manual 1 file/);
    expect(lines.at(-1)).toContain("2 row(s) planned");
  });

  it("uploads the approved media, inserts the rows, and writes the summary the CI comments", async () => {
    const q = fakeQueue();
    const { lines, out } = capture();
    expect(await runEnqueue(args("--summary=summary.json"), out, dir, { db: q.db, storage: q.storage, now: before })).toBe(0);
    expect(lines.at(-1)).toBe("2 scheduled, 0 skipped");
    expect(q.puts).toHaveLength(3);
    expect(q.puts[0]).toMatch(/^2026-W42\/2026-10-12-carousel-a\/en\/[0-9a-f]{64}\.jpg$/);
    expect(q.puts[2]).toMatch(/^2026-W42\/2026-10-13-story-a\/en\/[0-9a-f]{64}\.jpg$/);
    expect(q.inserted[0].media).toEqual(q.puts.slice(0, 2));
    expect(q.inserted.map((r) => `${r.account}:${r.status ?? "scheduled"}`)).toEqual(["en:scheduled", "en:manual"]);
    expect(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"))).toEqual({ scheduled: 2, updated: 0, skipped: [], canceled: [], revived: [] });
  });

  it("skips rows already queued with the same content and never uploads their media", async () => {
    const first = fakeQueue();
    await runEnqueue(args(), capture().out, dir, { db: first.db, storage: first.storage, now: before });
    const queued = first.inserted.map((r) => ({ ...r, status: r.status ?? "scheduled", rescheduledAt: null }) as unknown as QueueRow);
    const again = fakeQueue(queued);
    const { lines, out } = capture();
    expect(await runEnqueue(args("--summary=again.json"), out, dir, { db: again.db, storage: again.storage, now: before })).toBe(0);
    expect(lines.at(-1)).toBe("0 scheduled, 2 skipped");
    expect(again.puts).toEqual([]);
    expect(again.inserted).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "again.json"), "utf8")).skipped.map((s: { reason: string }) => s.reason)).toEqual(["already queued, unchanged", "already queued, unchanged"]);
  });

  const orphan = (over: Partial<QueueRow> = {}) =>
    ({ postId: "2026-10-09-carousel-a", account: "en", type: "carousel", week: "2026-W42", status: "scheduled", rescheduledAt: null, ...over }) as unknown as QueueRow;

  it("cancels a queued row that is not in the approved YAML (a post whose date changed) and reports it", async () => {
    const q = fakeQueue([orphan()]);
    const { lines, out } = capture();
    expect(await runEnqueue(args("--summary=orphan.json"), out, dir, { db: q.db, storage: q.storage, now: before })).toBe(0);
    expect(q.canceled).toEqual(["2026-10-09-carousel-a/en"]);
    expect(q.inserted).toHaveLength(2);
    const summary = JSON.parse(readFileSync(join(dir, "orphan.json"), "utf8"));
    expect(summary.canceled).toEqual([{ key: "2026-10-09-carousel-a/en", reason: expect.stringContaining("no longer in the week") }]);
    expect(lines.join("\n")).toContain("cancel 2026-10-09-carousel-a/en");
  });

  it("never cancels a publishing or published row", async () => {
    const q = fakeQueue([orphan({ status: "publishing" }), orphan({ postId: "2026-10-10-x", status: "published" })]);
    expect(await runEnqueue(args(), capture().out, dir, { db: q.db, storage: q.storage, now: before })).toBe(0);
    expect(q.canceled).toEqual([]);
  });

  describe("commit stamps and stale runs", () => {
    const [OLD, NEW] = ["1".repeat(40), "2".repeat(40)];
    const isAncestor = (a: string, b: string) => a === b || (a === OLD && b === NEW);
    const run = (q: ReturnType<typeof fakeQueue>, commit: string, ...extra: string[]) =>
      runEnqueue(args(`--commit=${commit}`, "--summary=stale.json", ...extra), capture().out, dir, { db: q.db, storage: q.storage, now: before, isAncestor, commitTime: () => "2026-10-12T09:00:00.000Z" });

    it("stamps every inserted row with the commit and its instant", async () => {
      const q = fakeQueue();
      expect(await run(q, NEW)).toBe(0);
      expect(q.inserted.map((r) => [r.sourceCommit, r.sourceCommittedAt])).toEqual([[NEW, "2026-10-12T09:00:00.000Z"], [NEW, "2026-10-12T09:00:00.000Z"]]);
    });

    it("a re-run of an old merge does not cancel a post that a newer merge queued", async () => {
      const q = fakeQueue([orphan({ postId: "2026-10-14-added-later", sourceCommit: NEW })]);
      expect(await run(q, OLD)).toBe(0);
      expect(q.canceled).toEqual([]);
      const summary = JSON.parse(readFileSync(join(dir, "stale.json"), "utf8"));
      expect(summary.canceled).toEqual([]);
      expect(summary.skipped).toEqual([{ key: "2026-10-14-added-later/en", kind: "newer", reason: expect.stringContaining("queued by a newer commit") }]);
    });

    it("the newer merge still cancels what an older merge queued", async () => {
      const q = fakeQueue([orphan({ sourceCommit: OLD })]);
      expect(await run(q, NEW)).toBe(0);
      expect(q.canceled).toEqual(["2026-10-09-carousel-a/en"]);
    });

    it("--dry-run does not list a cancellation that the real run would skip", async () => {
      const q = fakeQueue([orphan({ sourceCommit: NEW })]);
      const { lines, out } = capture();
      expect(await runEnqueue(args(`--commit=${OLD}`, "--dry-run"), out, dir, { db: q.db, now: before, isAncestor })).toBe(0);
      expect(lines.join("\n")).not.toContain("cancel 2026-10-09-carousel-a/en");
    });

    it("refuses a --commit that is not a full sha", async () => {
      const { lines, out } = capture();
      expect(await runEnqueue(args("--commit=main"), out, dir, { db: fakeQueue().db })).toBe(2);
      expect(lines[0]).toContain("--commit");
    });

    it("takes the commit from GITHUB_SHA when --commit is absent, and warns when there is none", async () => {
      const q = fakeQueue();
      await runEnqueue(args(), capture().out, dir, { db: q.db, storage: q.storage, now: before, env: { GITHUB_SHA: NEW }, commitTime: () => null });
      expect(q.inserted[0].sourceCommit).toBe(NEW);
      const none = fakeQueue();
      const { lines, out } = capture();
      await runEnqueue(args(), out, dir, { db: none.db, storage: none.storage, now: before, env: {}, headCommit: () => undefined });
      expect(none.inserted[0].sourceCommit).toBeNull();
      expect(lines.join("\n")).toContain("no commit");
    });
  });

  describe("canceled rows", () => {
    const canceledRow = (over: Partial<QueueRow> = {}) =>
      ({ postId: "2026-10-12-carousel-a", account: "en", type: "carousel", week: "2026-W42", status: "canceled", rescheduledAt: null, contentHash: "old", mediaHash: null, publishAt: "2026-10-12T11:00:00.000Z", ...over }) as unknown as QueueRow;

    it("brings back a post the enqueue canceled when the approved YAML has it again", async () => {
      const q = fakeQueue([canceledRow({ canceledBy: "enqueue" })]);
      const { lines, out } = capture();
      expect(await runEnqueue(args("--summary=revive.json"), out, dir, { db: q.db, storage: q.storage, now: before })).toBe(0);
      expect(q.revived).toEqual(["2026-10-12-carousel-a/en"]);
      expect(q.puts.length).toBeGreaterThan(0); // its media is uploaded again
      const summary = JSON.parse(readFileSync(join(dir, "revive.json"), "utf8"));
      expect(summary.revived).toEqual(["2026-10-12-carousel-a/en"]);
      expect(lines.join("\n")).toContain("restore 2026-10-12-carousel-a/en");
    });

    it("leaves a post the operator canceled alone and lists it", async () => {
      const q = fakeQueue([canceledRow({ canceledBy: "operator" })]);
      expect(await runEnqueue(args("--summary=operator.json"), capture().out, dir, { db: q.db, storage: q.storage, now: before })).toBe(0);
      expect(q.revived).toEqual([]);
      const summary = JSON.parse(readFileSync(join(dir, "operator.json"), "utf8"));
      expect(summary.skipped).toEqual([{ key: "2026-10-12-carousel-a/en", kind: "operator", reason: expect.stringContaining("weekpost restore") }]);
    });

    it("cancels orphans as the enqueue", async () => {
      const q = fakeQueue([orphan()]);
      await runEnqueue(args(), capture().out, dir, { db: q.db, storage: q.storage, now: before });
      expect(q.canceled).toEqual(["2026-10-09-carousel-a/en"]);
    });
  });

  it("--dry-run with a queue to read shows the cancellations and writes nothing", async () => {
    const q = fakeQueue([orphan()]);
    const { lines, out } = capture();
    expect(await runEnqueue(args("--dry-run"), out, dir, { db: q.db, storage: q.storage, now: before })).toBe(0);
    expect(lines.join("\n")).toContain("cancel 2026-10-09-carousel-a/en");
    expect(q.canceled).toEqual([]);
    expect(q.inserted).toEqual([]);
    expect(q.puts).toEqual([]);
  });

  it("skips a post whose publish time is past with a warning, queues the rest, and does not fail the run", async () => {
    const q = fakeQueue();
    const { lines, out } = capture();
    const after = () => new Date("2026-10-12T20:00:00Z"); // the carousel (11:00Z) is past, the story (07:00Z on the 13th) is not
    expect(await runEnqueue(args("--summary=past.json"), out, dir, { db: q.db, storage: q.storage, now: after })).toBe(0);
    expect(q.inserted.map((r) => r.postId)).toEqual(["2026-10-13-story-a"]);
    expect(q.puts).toHaveLength(1); // only the Story's image
    expect(lines.join("\n")).toContain("skip 2026-10-12-carousel-a/en (publish time 2026-10-12T11:00:00.000Z is in the past; use --allow-past");
    expect(lines.at(-1)).toBe("1 scheduled, 1 skipped");
    expect(JSON.parse(readFileSync(join(dir, "past.json"), "utf8")).skipped).toEqual([
      { key: "2026-10-12-carousel-a/en", kind: "past", reason: expect.stringContaining("is in the past") },
    ]);
  });

  it("--allow-past queues the past post anyway", async () => {
    const q = fakeQueue();
    const after = () => new Date("2026-10-12T20:00:00Z");
    expect(await runEnqueue(args("--allow-past"), capture().out, dir, { db: q.db, storage: q.storage, now: after })).toBe(0);
    expect(q.inserted).toHaveLength(2);
  });

  it("a post whose time is past does not hold back the cancellation of an orphan", async () => {
    const q = fakeQueue([orphan()]);
    const after = () => new Date("2026-10-12T20:00:00Z");
    expect(await runEnqueue(args(), capture().out, dir, { db: q.db, storage: q.storage, now: after })).toBe(0);
    expect(q.canceled).toEqual(["2026-10-09-carousel-a/en"]);
  });

  it("does not refuse a past row that is already queued and unchanged (a re-run after the post went out)", async () => {
    const first = fakeQueue();
    await runEnqueue(args(), capture().out, dir, { db: first.db, storage: first.storage, now: before });
    const queued = first.inserted.map((r) => ({ ...r, status: "published", rescheduledAt: null }) as unknown as QueueRow);
    const again = fakeQueue(queued);
    const after = () => new Date("2026-12-01T00:00:00Z");
    expect(await runEnqueue(args(), capture().out, dir, { db: again.db, storage: again.storage, now: after })).toBe(0);
  });

  it("--dry-run lists the past posts without failing (the queue decides what would be written)", async () => {
    const { lines, out } = capture();
    const after = () => new Date("2026-10-12T20:00:00Z");
    expect(await runEnqueue(args("--dry-run"), out, dir, { env: {}, now: after })).toBe(0);
    expect(lines.join("\n")).toContain("past 2026-10-12-carousel-a/en 2026-10-12T11:00:00.000Z (skipped without --allow-past)");
  });

  it("fails without writing anything when one byte of the media changed", async () => {
    const file = join(dir, "out", "2026-W42", "2026-10-12-carousel-a", "en", "01.jpg");
    const original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from([0])]));
    const q = fakeQueue();
    const { lines, out } = capture();
    try {
      expect(await runEnqueue(args("--summary=bad.json"), out, dir, { db: q.db, storage: q.storage, now: before })).toBe(1);
    } finally {
      writeFileSync(file, original);
    }
    expect(lines.join("\n")).toContain("01.jpg: hash on disk differs from the manifest");
    expect(lines.at(-1)).toBe("nothing was scheduled");
    expect(q.puts).toEqual([]);
    expect(q.inserted).toEqual([]);
  });

  it("refuses a media file that is a symbolic link", async () => {
    const file = join(dir, "out", "2026-W42", "2026-10-13-story-a", "en", "story.jpg");
    const original = readFileSync(file);
    const real = join(dir, "real.jpg");
    writeFileSync(real, original);
    rmSync(file);
    symlinkSync(real, file);
    try {
      const { lines, out } = capture();
      expect(await runEnqueue(args("--dry-run"), out, dir)).toBe(1);
      expect(lines.join("\n")).toContain("is a symbolic link");
    } finally {
      rmSync(file);
      writeFileSync(file, original);
    }
  });

  it("refuses a manifest without version 1", async () => {
    const file = join(dir, "out", "2026-W42", "manifest.json");
    const original = readFileSync(file, "utf8");
    const json = JSON.parse(original);
    delete json.version;
    writeFileSync(file, JSON.stringify(json));
    try {
      const { lines, out } = capture();
      expect(await runEnqueue(args("--dry-run"), out, dir)).toBe(1);
      expect(lines.join("\n")).toContain("not a valid v1 manifest");
    } finally {
      writeFileSync(file, original);
    }
  });

  it("fails clearly when the Supabase env is missing outside --dry-run", async () => {
    const { lines, out } = capture();
    expect(await runEnqueue(args(), out, dir, { env: {} })).toBe(1);
    expect(lines.join("\n")).toContain("WEEKPOST_SUPABASE_URL");
  });

  it("fails when the artifact directory or the week folder is missing, and when the weeks file has a bad line", async () => {
    expect(await runEnqueue(["nope", `--weeks=${weeksFile()}`, "--dry-run"], capture().out, dir)).toBe(1);
    writeFileSync(join(dir, "other.txt"), "2026-W43\n");
    const missing = capture();
    expect(await runEnqueue(["out", "--weeks=other.txt", "--dry-run"], missing.out, dir)).toBe(1);
    expect(missing.lines.join("\n")).toContain("week 2026-W43 not found");
    writeFileSync(join(dir, "bad.txt"), "week 43\n");
    const bad = capture();
    expect(await runEnqueue(["out", "--weeks=bad.txt", "--dry-run"], bad.out, dir)).toBe(1);
    expect(bad.lines[0]).toContain("not a week");
  });

  it("an empty weeks file is not an error and writes a zero summary", async () => {
    writeFileSync(join(dir, "empty.txt"), "\n");
    const { lines, out } = capture();
    expect(await runEnqueue(["out", "--weeks=empty.txt", "--summary=zero.json"], out, dir, { env: {} })).toBe(0);
    expect(lines[0]).toContain("0 scheduled, 0 skipped");
    expect(JSON.parse(readFileSync(join(dir, "zero.json"), "utf8"))).toEqual({ scheduled: 0, updated: 0, skipped: [], canceled: [] });
  });
});
