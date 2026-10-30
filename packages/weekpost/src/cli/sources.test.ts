import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLocalSourceEnv, runSources } from "./sources.ts";

const config = (sources: string, header = "") => `${header}export default {
  brand: {
    name: "Shop",
    colors: { primary: "#2F6B3A", dark: "#173A20", bg: "#F7F4EA", fg: "#141A14", muted: "#5B6157", tint: "#E3EFE0", onDark: "#E6F2E3", onDarkMuted: "#C2D8BD" },
    font: { family: "Inter", files: { 400: "assets/a.woff2", 800: "assets/b.woff2" } },
    logo: { file: "assets/logo.svg" },
  },
  accounts: { en: { handle: "shop", lang: "en", timeZone: "Europe/London", hemisphere: "north", voice: "george", cta: ["link in bio"], link: { base: "https://shop.example/" } } },
  pillars: ["tip"],
  ${sources}
};
`;

function project(sources: string, files: Record<string, string> = {}, header = "") {
  const dir = mkdtempSync(join(tmpdir(), "weekpost-sources-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  for (const f of ["a.woff2", "b.woff2", "logo.svg"]) writeFileSync(join(dir, "assets", f), "x");
  writeFileSync(join(dir, "weekpost.config.ts"), config(sources, header));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const cap = () => {
  const lines: string[] = [];
  return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) } };
};
const written = (dir: string, week: string) => JSON.parse(readFileSync(join(dir, "content", week, "sources.json"), "utf8"));
const NOW = () => new Date("2026-10-26T08:00:00Z");

const fixed = (items: string) => `sources: [{ name: "fixed", pull: async (q, ctx) => ${items} }],`;

describe("weekpost sources pull", () => {
  it("writes sources.json with the window and the cleaned items", async () => {
    const dir = project(fixed(`[{ id: "1", title: "<b>Hello</b>", url: "https://e.com/1", publishedAt: "2026-10-21T10:00:00Z" }, { id: "2", title: "bad", url: "http://e.com/2", publishedAt: "2026-10-21T10:00:00Z" }]`));
    const { lines, out } = cap();
    expect(await runSources(["pull", "2026-W44"], out, dir, { env: {}, now: NOW })).toBe(0);
    expect(written(dir, "2026-W44")).toEqual({
      version: 1, week: "2026-W44", from: "2026-10-19T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z", pulledAt: "2026-10-26T08:00:00.000Z",
      items: [{ source: "fixed", id: "1", title: "Hello", url: "https://e.com/1", publishedAt: "2026-10-21T10:00:00.000Z" }],
    });
    expect(lines.join("\n")).toMatch(/dropped 1/);
  });

  it("with no source configured writes an empty list and exits 0", async () => {
    const dir = project("");
    const { out } = cap();
    expect(await runSources(["pull", "2026-W44"], out, dir, { env: {}, now: NOW })).toBe(0);
    expect(written(dir, "2026-W44").items).toEqual([]);
  });

  it("exits 4 when the sources answer with no items, and says the window", async () => {
    const dir = project(fixed("[]"));
    const { lines, out } = cap();
    expect(await runSources(["pull", "2026-W44"], out, dir, { env: {}, now: NOW })).toBe(4);
    expect(lines.join("\n")).toContain("no published items between 2026-10-19T00:00:00.000Z and 2026-10-26T00:00:00.000Z");
    expect(written(dir, "2026-W44").items).toEqual([]);
  });

  it("exits 1 naming the adapter when it fails, which is not an empty week", async () => {
    const dir = project(`sources: [{ name: "db", pull: async () => { throw new Error("unreachable"); } }],`);
    const { lines, out } = cap();
    expect(await runSources(["pull", "2026-W44"], out, dir, { env: {}, now: NOW })).toBe(1);
    expect(lines.join("\n")).toMatch(/"db" failed: unreachable/);
  });

  it("hands the adapter only WEEKPOST_SOURCE_* from the environment and .env.local", async () => {
    const dir = project(
      fixed(`[{ id: "1", title: JSON.stringify(ctx.env), url: "https://e.com/1", publishedAt: "2026-10-21T10:00:00Z" }]`),
      { ".env.local": 'WEEKPOST_SOURCE_A=from-file\nWEEKPOST_SOURCE_B="quoted"\nWEEKPOST_SUPABASE_KEY=nope\nOTHER=1\n' },
    );
    const { out } = cap();
    const env = { WEEKPOST_SOURCE_A: "from-env", WEEKPOST_SUPABASE_URL: "u", WEEKPOST_SUPABASE_KEY: "k", CLOUDFLARE_API_TOKEN: "t" };
    expect(await runSources(["pull", "2026-W44"], out, dir, { env, now: NOW })).toBe(0);
    expect(JSON.parse(written(dir, "2026-W44").items[0].title)).toEqual({ WEEKPOST_SOURCE_A: "from-env", WEEKPOST_SOURCE_B: "quoted" });
  });

  it("works end to end with ideasFile and the commit date of the line", async () => {
    const entry = new URL("../index.ts", import.meta.url).href;
    const dir = project(`sources: [ideasFile({ path: "ideas.md" })],`, {}, `import { ideasFile } from ${JSON.stringify(entry)};\n`);
    writeFileSync(join(dir, "ideas.md"), "- A last-week idea \u2014 https://example.com/idea\n");
    const date = "2026-10-21T10:00:00Z";
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    git("init", "-q");
    git("add", "ideas.md");
    git("commit", "-q", "-m", "idea");
    const { out } = cap();
    expect(await runSources(["pull", "2026-W44"], out, dir, { env: {}, now: NOW })).toBe(0);
    const items = written(dir, "2026-W44").items;
    expect(items.map((i: { title: string; publishedAt: string; source: string }) => [i.source, i.title, i.publishedAt])).toEqual([["ideasFile", "A last-week idea", "2026-10-21T10:00:00.000Z"]]);
    expect(await runSources(["pull", "2026-W45"], cap().out, dir, { env: {}, now: NOW })).toBe(4);
  });

  it("rejects bad arguments with exit 2", async () => {
    const dir = project("");
    for (const args of [[], ["pull"], ["push", "2026-W44"], ["pull", "2026-44"], ["pull", "2026-W44", "--limit=0"], ["pull", "2026-W44", "--limit=x"]]) {
      expect(await runSources(args, cap().out, dir, { env: {} })).toBe(2);
    }
  });
});

describe("readLocalSourceEnv", () => {
  it("is empty without a file", () => {
    expect(readLocalSourceEnv(mkdtempSync(join(tmpdir(), "wp-noenv-")))).toEqual({});
  });
});
