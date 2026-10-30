import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runGenerate } from "../src/cli/generate.ts";
import { runPackage } from "../src/cli/package.ts";
import { silentMp3 } from "../src/media/fake.ts";
import { testConfig, testProject } from "./fixtures/brand.ts";

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


const capture = () => {
  const lines: string[] = [];
  return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) } };
};

describe("weekpost package", () => {
  let dir: string;
  beforeAll(async () => {
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
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fails and says what to run when the week was not generated", async () => {
    const { lines, out } = capture();
    expect(await runPackage(["2026-W42"], out, dir)).toBe(1);
    expect(lines.join("\n")).toContain("run weekpost generate 2026-W42 first");
  });

  it("prints usage without a week", async () => {
    const { lines, out } = capture();
    expect(await runPackage([], out, dir)).toBe(2);
    expect(lines[0]).toContain("usage: weekpost package");
  });

  it("packages a generated week, and refuses media that changed after generation", async () => {
    expect(await runGenerate(["2026-W42", "--fake-media"], capture().out, dir)).toBe(0);
    const { lines, out } = capture();
    expect(await runPackage(["2026-W42"], out, dir)).toBe(0);
    const dest = join(dir, "out", "package", "2026-W42", "2026-10-12-en");
    const carousel = join(dest, "1200-carousel-carousel-a");
    expect(existsSync(join(carousel, "01.jpg"))).toBe(true);
    expect(existsSync(join(carousel, "02.jpg"))).toBe(true);
    expect(readFileSync(join(carousel, "caption.txt"), "utf8")).toMatch(/^Caption\./);
    expect(readFileSync(join(carousel, "time.txt"), "utf8")).toContain("time zone: Europe/London");
    expect(readFileSync(join(carousel, "link.txt"), "utf8")).toContain("utm_content=carousel-a");
    expect(existsSync(join(dest, "1800-reel-reel-a", "silent.mp4"))).toBe(true);
    expect(existsSync(join(dest, "1800-reel-reel-a", "voice.mp4"))).toBe(false);
    expect(lines.at(-1)).toContain("2 folder(s)");

    const only = capture();
    expect(await runPackage(["2026-W42", "--post=2026-10-12-reel-a", "--dest=only"], only.out, dir)).toBe(0);
    expect(only.lines.at(-1)).toContain("1 folder(s)");
    expect(await runPackage(["2026-W42", "--post=nope"], capture().out, dir)).toBe(1);

    writeFileSync(join(dir, "out", "2026-W42", "2026-10-12-carousel-a", "en", "01.jpg"), "tampered");
    const bad = capture();
    expect(await runPackage(["2026-W42"], bad.out, dir)).toBe(1);
    expect(bad.lines.join("\n")).toContain("differs from the manifest");
  }, 120_000);
});
