import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_VERSION, manifestSchema, sha256File, verifyManifest, type Manifest } from "./manifest.ts";

const HASH = "a".repeat(64);
const valid = (): Manifest => ({
  version: 1,
  generator: "weekpost@0.1.0",
  week: "2026-W42",
  spentUsd: 0.4,
  budgetUsd: 5,
  warnings: [],
  posts: [
    {
      id: "2026-10-12-carousel-a",
      type: "carousel",
      date: "2026-10-12",
      times: { en: "12:00" },
      timeZones: { en: "Europe/London" },
      contentHash: HASH,
      accounts: {
        en: {
          files: ["2026-10-12-carousel-a/en/01.jpg", "2026-10-12-carousel-a/en/02.jpg"],
          publish: ["2026-10-12-carousel-a/en/01.jpg", "2026-10-12-carousel-a/en/02.jpg"],
          caption: "Caption.",
          sha256: { "2026-10-12-carousel-a/en/01.jpg": HASH, "2026-10-12-carousel-a/en/02.jpg": HASH },
        },
      },
      coherence: [],
    },
  ],
});

const reelManifest = (): Manifest => {
  const m = valid();
  m.posts[0] = {
    ...m.posts[0], id: "r", type: "reel",
    accounts: { en: {
      files: ["r/en/voice.mp4", "r/en/silent.mp4"], publish: ["r/en/silent.mp4"], cover: "r/en/cover.jpg", audio: "r/en/narration.mp3",
      caption: "x", sha256: { "r/en/silent.mp4": HASH, "r/en/cover.jpg": HASH },
    } },
  };
  return m;
};

const issues = (m: unknown) => {
  const r = manifestSchema.safeParse(m);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("manifest v1 schema", () => {
  it("accepts a carousel and a Reel manifest", () => {
    expect(MANIFEST_VERSION).toBe(1);
    expect(issues(valid())).toEqual([]);
    expect(issues(reelManifest())).toEqual([]);
  });

  it("accepts a post that failed, with no accounts", () => {
    const m = valid();
    m.posts[0] = { ...m.posts[0], accounts: {}, error: "boom" };
    expect(issues(m)).toEqual([]);
  });

  it("rejects a manifest without a version, or with another one", () => {
    const { version: _v, ...rest } = valid();
    expect(issues(rest).join()).toMatch(/version/);
    expect(issues({ ...valid(), version: 2 }).join()).toMatch(/version/);
  });

  it.each([
    ["a parent segment", "p/en/../x.jpg"],
    ["a leading ..", "../en/01.jpg"],
    ["an absolute path", "/p/en/01.jpg"],
    ["a backslash", "p\\en\\01.jpg"],
    ["a URL-encoded segment", "p/en/%2e%2e.jpg"],
    ["a wrong depth", "p/01.jpg"],
    ["a wrong extension", "p/en/01.png"],
  ])("rejects a path with %s", (_name, path) => {
    const m = valid();
    m.posts[0].accounts.en = { ...m.posts[0].accounts.en, files: [path], publish: [path], sha256: { [path]: HASH } };
    expect(issues(m).length).toBeGreaterThan(0);
  });

  it("rejects a publish entry that is not in files", () => {
    const m = valid();
    m.posts[0].accounts.en.publish = ["2026-10-12-carousel-a/en/03.jpg"];
    m.posts[0].accounts.en.sha256 = { "2026-10-12-carousel-a/en/03.jpg": HASH };
    expect(issues(m).join()).toMatch(/publish.*not listed in files/);
  });

  it("rejects an empty publish list", () => {
    const m = valid();
    m.posts[0].accounts.en.publish = [];
    expect(issues(m).length).toBeGreaterThan(0);
  });

  it("requires a sha256 for exactly the publish files and the cover", () => {
    const missing = reelManifest();
    delete missing.posts[0].accounts.en.sha256["r/en/cover.jpg"];
    expect(issues(missing).join()).toMatch(/sha256/);
    const extra = reelManifest();
    extra.posts[0].accounts.en.sha256["r/en/voice.mp4"] = HASH;
    expect(issues(extra).join()).toMatch(/sha256/);
  });

  it("rejects a malformed hash, an unknown field and a bad account id", () => {
    const bad = valid();
    bad.posts[0].contentHash = "xyz";
    expect(issues(bad).join()).toMatch(/contentHash/);
    expect(issues({ ...valid(), extra: 1 }).length).toBeGreaterThan(0);
    const m = valid();
    m.posts[0].accounts = { "BAD ID": m.posts[0].accounts.en };
    expect(issues(m).length).toBeGreaterThan(0);
  });
});

describe("verifyManifest", () => {
  function onDisk() {
    const dir = mkdtempSync(join(tmpdir(), "weekpost-manifest-"));
    const m = valid();
    for (const f of m.posts[0].accounts.en.publish) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), `bytes of ${f}`);
      m.posts[0].accounts.en.sha256[f] = sha256File(join(dir, f));
    }
    return { dir, m };
  }

  it("passes when every hash matches the file on disk", () => {
    const { dir, m } = onDisk();
    expect(verifyManifest(m, dir)).toEqual([]);
  });

  it("reports a file that changed and a file that is missing", () => {
    const { dir, m } = onDisk();
    writeFileSync(join(dir, "2026-10-12-carousel-a/en/01.jpg"), "tampered");
    m.posts[0].accounts.en.sha256["2026-10-12-carousel-a/en/02.jpg"] = HASH;
    const problems = verifyManifest(m, dir);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/01\.jpg.*hash differs/);
    expect(problems[1]).toMatch(/02\.jpg.*hash differs/);
    const { dir: dir2, m: m2 } = onDisk();
    writeFileSync(join(dir2, "2026-10-12-carousel-a/en/02.jpg"), "x");
    expect(verifyManifest(m2, dir2)).toHaveLength(1);
  });

  it("reports a missing file", () => {
    const { dir, m } = onDisk();
    m.posts[0].accounts.en.files.push("2026-10-12-carousel-a/en/09.jpg");
    m.posts[0].accounts.en.publish.push("2026-10-12-carousel-a/en/09.jpg");
    m.posts[0].accounts.en.sha256["2026-10-12-carousel-a/en/09.jpg"] = HASH;
    expect(verifyManifest(m, dir).join()).toMatch(/09\.jpg: missing/);
  });
});
