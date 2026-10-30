import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { runGenerate } from "../src/cli/generate.ts";
import { manifestSchema, verifyManifest } from "../src/render/manifest.ts";
import { contentHash } from "../src/content/hash.ts";
import { checkContent } from "../src/content/load.ts";
import { silentMp3 } from "../src/media/fake.ts";
import { loadConfig } from "../src/config/load.ts";
import { testConfig, testProject } from "./fixtures/brand.ts";
import { mkdirSync } from "node:fs";

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
    link: { en: "https://hortaviva.example/?utm_source=instagram&utm_medium=social&utm_campaign=en&utm_content=carousel-a" }
  - id: 2026-10-12-reel-a
    date: 2026-10-12
    type: reel
    accounts: [en]
    times: { en: "18:00" }
    pillar: tip
    reel:
      segments:
        - { text: { en: "Water early." }, image_prompt: "a can", seconds: 4 }
        - { text: { en: "Mulch." }, image_prompt: "mulch", seconds: 4 }
      narration: { en: "Water early in the day. Then add mulch." }
      music: calm
      variant: silent
    caption: { en: "Caption." }
    cta: { en: "Link in bio." }
    link: { en: "https://hortaviva.example/?utm_source=instagram&utm_medium=social&utm_campaign=en&utm_content=reel-a" }
`;

describe("weekpost generate --fake-media", () => {
  let dir: string;
  beforeEach(async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network is off in this test")));
    dir = testProject();
    const input = testConfig();
    input.accounts = { en: input.accounts.en };
    writeFileSync(join(dir, "weekpost.config.ts"), `export default ${JSON.stringify(input)};\n`);
    mkdirSync(join(dir, "content", "2026-W42"), { recursive: true });
    writeFileSync(join(dir, "content", "2026-W42", "posts.yaml"), WEEK);
    mkdirSync(join(dir, "assets", "music"), { recursive: true });
    writeFileSync(join(dir, "assets", "music", "calm.mp3"), await silentMp3("x".repeat(300)));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders carousel and Reel without a key or network, into out/ of the project", async () => {
    const lines: string[] = [];
    const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    expect(await runGenerate(["2026-W42", "--fake-media"], out, dir)).toBe(0);
    expect(lines.join("\n")).toContain("ok 2026-10-12-reel-a");
    const week = join(dir, "out", "2026-W42");
    for (const f of ["2026-10-12-carousel-a/en/01.jpg", "2026-10-12-carousel-a/en/02.jpg", "2026-10-12-reel-a/en/voice.mp4", "2026-10-12-reel-a/en/silent.mp4", "index.html"]) {
      expect(existsSync(join(week, f)), f).toBe(true);
    }
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(week, "manifest.json"), "utf8")));
    expect(manifest.version).toBe(1);
    expect(manifest.generator).toMatch(/^weekpost@\d/);
    expect(manifest.spentUsd).toBe(0);
    expect(manifest.posts[0].accounts.en.publish).toEqual(["2026-10-12-carousel-a/en/01.jpg", "2026-10-12-carousel-a/en/02.jpg"]);
    expect(manifest.posts[1].accounts.en.publish).toEqual(["2026-10-12-reel-a/en/silent.mp4"]);
    expect(manifest.posts[1].timeZones).toEqual({ en: "Europe/London" });
    // The recorded hashes are the bytes on disk.
    expect(verifyManifest(manifest, week)).toEqual([]);
    const sha = manifest.posts[0].accounts.en.sha256["2026-10-12-carousel-a/en/01.jpg"];
    expect(sha).toBe(createHash("sha256").update(readFileSync(join(week, "2026-10-12-carousel-a/en/01.jpg"))).digest("hex"));
    // The content hash is the one a consumer computes from the YAML.
    const [posted] = checkContent(join(dir, "content"), (await loadConfig(dir)).config, "2026-W42").weeks[0].posts;
    expect(manifest.posts[0].contentHash).toBe(contentHash(posted));
    // The preview names the account by its @handle, in English.
    const html = readFileSync(join(week, "index.html"), "utf8");
    expect(html).toContain("@hortaviva");
    expect(html).toContain("Week cost");
    expect(manifest.posts[1].accounts.en.music).toBe("calm");
  }, 120_000);

  it("--post renders only that post", async () => {
    const lines: string[] = [];
    const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    expect(await runGenerate(["2026-W42", "--fake-media", "--post=2026-10-12-carousel-a"], out, dir)).toBe(0);
    expect(lines.join("\n")).toContain("ok 2026-10-12-carousel-a");
    expect(lines.join("\n")).not.toContain("2026-10-12-reel-a");
    const week = join(dir, "out", "2026-W42");
    expect(existsSync(join(week, "2026-10-12-carousel-a/en/01.jpg"))).toBe(true);
    expect(existsSync(join(week, "2026-10-12-reel-a"))).toBe(false);
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(week, "manifest.json"), "utf8")));
    expect(manifest.posts.map((p) => p.id)).toEqual(["2026-10-12-carousel-a"]);
  }, 120_000);

  it("--post keeps the other posts of the previous manifest and rejects an unknown id", async () => {
    const lines: string[] = [];
    const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    expect(await runGenerate(["2026-W42", "--fake-media"], out, dir)).toBe(0);
    expect(await runGenerate(["2026-W42", "--fake-media", "--post=2026-10-12-carousel-a"], out, dir)).toBe(0);
    const manifestFile = join(dir, "out", "2026-W42", "manifest.json");
    expect(manifestSchema.parse(JSON.parse(readFileSync(manifestFile, "utf8"))).posts.map((p) => p.id)).toEqual(["2026-10-12-carousel-a", "2026-10-12-reel-a"]);
    lines.length = 0;
    expect(await runGenerate(["2026-W42", "--fake-media", "--post=nope"], out, dir)).toBe(1);
    expect(lines.join("\n")).toContain("nope");
  }, 120_000);

  it("without --fake-media and without a key, fails with a clear message", async () => {
    const lines: string[] = [];
    const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    expect(await runGenerate(["2026-W42"], out, dir)).toBe(1);
    expect(lines.join("\n")).toContain("OPENROUTER_API_KEY is missing");
  });

  it("prints usage without a week", async () => {
    const lines: string[] = [];
    expect(await runGenerate([], { log: (l) => lines.push(l), error: (l) => lines.push(l) }, dir)).toBe(2);
    expect(lines[0]).toContain("usage: weekpost generate");
  });
});
