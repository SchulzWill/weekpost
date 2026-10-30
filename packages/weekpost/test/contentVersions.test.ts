// Old contract versions: the package reads them and never rewrites a week.
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testConfig } from "../src/content/fixtures.ts";
import { checkContent } from "../src/content/load.ts";
import { CONTENT_VERSION, MIN_CONTENT_VERSION } from "../src/content/post.ts";
import { readAsCurrent, validateWeek, type Contract, type RawWeek } from "../src/content/week.ts";

const config = testConfig();
const fixture = new URL("./fixtures/content-v1/", import.meta.url);

// A pretend next contract: v2 renamed `call_to_action` (v1) to `cta`. Everything else is the shape the code knows.
const V2: Contract = {
  current: 2,
  min: 1,
  readers: {
    1: (raw) => ({
      ...raw,
      version: 2,
      posts: (raw.posts as RawWeek[]).map(({ call_to_action, ...post }) => ({ ...post, cta: call_to_action })),
    }),
  },
};

const copyFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "weekpost-v1-"));
  cpSync(fixture, root, { recursive: true });
  return root;
};

describe("the shipped contract", () => {
  it("reads a v1 week with the current package, and leaves the file as it was", () => {
    const root = copyFixture();
    const file = join(root, "2026-W42/posts.yaml");
    const before = readFileSync(file, "utf8");
    expect(before.startsWith("version: 1\n")).toBe(true);
    const { weeks, issues } = checkContent(root, config);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(weeks[0].posts.map((p) => p.id)).toEqual(["2026-10-12-story-open"]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("reads from MIN_CONTENT_VERSION up to CONTENT_VERSION and nothing else", () => {
    expect(MIN_CONTENT_VERSION).toBeLessThanOrEqual(CONTENT_VERSION);
    for (let v = MIN_CONTENT_VERSION; v <= CONTENT_VERSION; v++) expect(readAsCurrent({ version: v, posts: [] }).error).toBeUndefined();
    expect(readAsCurrent({ version: CONTENT_VERSION + 1, posts: [] }).error).toMatch(/newer.*update weekpost/);
    expect(readAsCurrent({ version: MIN_CONTENT_VERSION - 1, posts: [] }).error).toMatch(/older/);
    expect(readAsCurrent({ version: "1", posts: [] }).error).toMatch(/whole number/);
    expect(readAsCurrent({ posts: [] }).error).toMatch(/version: 1/);
  });
});

describe("a package with a next contract version (fixture)", () => {
  const v1 = (): RawWeek => ({
    version: 1,
    posts: [
      {
        id: "2026-10-12-story-open",
        date: "2026-10-12",
        type: "story",
        accounts: ["a"],
        times: { a: "11:00" },
        pillar: "other",
        story: { text: { a: "Open spots." }, link_utm_content: "story-2026-10-12" },
        caption: { a: "Spots." },
        call_to_action: { a: "Link na bio." },
        link: { a: "https://example.com/a/?utm_source=instagram&utm_medium=social&utm_campaign=a&utm_content=story-2026-10-12" },
      },
    ],
  });

  it("validates a v1 week through its reader, without touching the input", () => {
    const raw = v1();
    const snapshot = structuredClone(raw);
    const { posts, issues } = validateWeek("2026-W42", raw, config, V2);
    expect(issues).toEqual([]);
    expect(posts[0].cta).toEqual({ a: "Link na bio." });
    expect(raw).toEqual(snapshot);
  });

  it("validates a v2 week as it is, and rejects v3", () => {
    const { call_to_action, ...rest } = (v1().posts as RawWeek[])[0];
    const v2 = { version: 2, posts: [{ ...rest, cta: call_to_action }] };
    expect(validateWeek("2026-W42", v2, config, V2).issues).toEqual([]);
    expect(validateWeek("2026-W42", { ...v2, version: 3 }, config, V2).issues[0].message).toMatch(/newer/);
  });

  it("names the week and the version when a version has no reader or fell below the minimum", () => {
    const gap = validateWeek("2026-W42", v1(), config, { ...V2, readers: {} }).issues[0];
    expect(gap).toMatchObject({ where: "2026-W42 version", message: expect.stringContaining("no reader for version 1") });
    const old = validateWeek("2026-W42", v1(), config, { ...V2, min: 2 }).issues[0];
    expect(old.message).toMatch(/older than this weekpost reads \(from 2\)/);
  });

  it("an error in an old week still points at the field", () => {
    const raw = v1();
    (raw.posts as RawWeek[])[0].times = {};
    const { issues } = validateWeek("2026-W42", raw, config, V2);
    expect(issues.some((i) => i.where.includes("times"))).toBe(true);
  });
});
