// End to end: the shipped example project renders with placeholder media, real Chromium and real ffmpeg.
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runGenerate } from "../src/cli/generate.ts";
import { manifestSchema, verifyManifest } from "../src/render/manifest.ts";

const EXAMPLE = resolve(import.meta.dirname, "../../../examples/horta-viva");

describe("examples/horta-viva", () => {
  const project = EXAMPLE;
  const lines: string[] = [];

  beforeAll(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    // The config imports "weekpost", so the project must stay inside the workspace; out/ is git-ignored and removed after.
    rmSync(join(project, "out"), { recursive: true, force: true });
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(join(project, "out"), { recursive: true, force: true });
  });

  it("ships five ideas and the config reads them through ideasFile", async () => {
    const { parseIdeas } = await import("../src/sources/ideasFile.ts");
    const { loadConfig } = await import("../src/config/load.ts");
    expect(parseIdeas(readFileSync(join(project, "ideas.md"), "utf8"))).toHaveLength(5);
    const { config } = await loadConfig(project);
    expect(config.sources?.map((s) => s.name)).toEqual(["ideasFile"]);
  });

  it("generates 2026-W45 with --fake-media and the manifest validates", async () => {
    const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    const started = performance.now();
    expect(await runGenerate(["2026-W45", "--fake-media"], out, project), lines.join("\n")).toBe(0);
    const renderSeconds = (performance.now() - started) / 1000;

    const week = join(project, "out", "2026-W45");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(week, "manifest.json"), "utf8")));
    expect(manifest.version).toBe(1);
    expect(manifest.spentUsd).toBe(0);
    expect(manifest.posts.map((p) => p.id)).toEqual(["2026-11-02-carousel-herbs", "2026-11-04-story-seeds", "2026-11-06-reel-watering", "2026-11-08-reel-weekly-recap"]);

    const [carousel, story, reel, recap] = manifest.posts;
    expect(Object.keys(carousel.accounts).sort()).toEqual(["en", "pt-br"]);
    expect(carousel.accounts.en.publish).toHaveLength(3);
    expect(carousel.accounts["pt-br"].publish).toHaveLength(3);
    expect(carousel.timeZones).toEqual({ en: "Europe/London", "pt-br": "America/Sao_Paulo" });
    expect(story.accounts.en.publish).toEqual(["2026-11-04-story-seeds/en/story.jpg"]);
    expect(reel.accounts.en.publish).toEqual(["2026-11-06-reel-watering/en/voice.mp4"]);
    expect(reel.accounts.en.music).toBeUndefined();

    // Every published file exists and its recorded hash matches the bytes on disk.
    for (const post of manifest.posts) for (const acc of Object.values(post.accounts)) for (const f of acc.publish) expect(existsSync(join(week, f)), f).toBe(true);
    expect(verifyManifest(manifest, week)).toEqual([]);

    // The 60 s recap Reel: 8 segments, catalog voice, no music, MP4 under the 50 MiB bucket limit.
    expect(recap.accounts.en.publish).toEqual(["2026-11-08-reel-weekly-recap/en/voice.mp4"]);
    expect(recap.accounts.en.music).toBeUndefined();
    const bytes = statSync(join(week, recap.accounts.en.publish[0])).size;
    console.log(`long reel (fake media): week render ${renderSeconds.toFixed(1)} s, recap MP4 ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
    expect(bytes).toBeLessThan(50 * 1024 * 1024);
  }, 240_000);
});
