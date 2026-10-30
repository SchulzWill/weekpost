import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "../src/cli/check.ts";
import { main } from "../src/cli/main.ts";

const CONFIG = `export default {
  brand: {
    name: "Shop",
    colors: { primary: "#2F6B3A", dark: "#173A20", bg: "#F7F4EA", fg: "#141A14", muted: "#5B6157", tint: "#E3EFE0", onDark: "#E6F2E3", onDarkMuted: "#C2D8BD" },
    font: { family: "Inter", files: { 400: "assets/a.woff2", 800: "assets/b.woff2" } },
    logo: { file: "assets/logo.svg" },
  },
  accounts: { en: { handle: "shop", lang: "en", timeZone: "Europe/London", hemisphere: "north", voice: "george", cta: ["link in bio"], link: { base: "https://shop.example/" } } },
  pillars: ["tip"],
};
`;

const post = (over = "") => `version: 1
posts:
  - id: 2026-10-12-story-a
    date: 2026-10-12
    type: story
    accounts: [en]
    times: { en: "12:00" }
    pillar: tip${over}
    story: { text: { en: "Open spots." }, link_utm_content: story-a }
    caption: { en: "Spots." }
    cta: { en: "Link in bio." }
    link: { en: "https://shop.example/?utm_source=instagram&utm_medium=social&utm_campaign=en&utm_content=story-a" }
`;

function project(weeks: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "weekpost-check-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  for (const f of ["a.woff2", "b.woff2", "logo.svg"]) writeFileSync(join(dir, "assets", f), "x");
  writeFileSync(join(dir, "weekpost.config.ts"), CONFIG);
  for (const [week, body] of Object.entries(weeks)) {
    mkdirSync(join(dir, "content", week), { recursive: true });
    writeFileSync(join(dir, "content", week, "posts.yaml"), body);
  }
  return dir;
}

const capture = () => {
  const lines: string[] = [];
  return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) } };
};

describe("weekpost check", () => {
  it("exits 0 for a valid week and prints the summary", async () => {
    const dir = project({ "2026-W42": post() });
    const { lines, out } = capture();
    expect(await runCheck([`--root=${join(dir, "content")}`, "2026-W42"], out)).toBe(0);
    expect(lines).toEqual(["1 week(s), 1 post(s), 0 error(s), 0 warning(s)"]);
  });

  it("finds the project from the current directory when --root is absent", async () => {
    const dir = project({ "2026-W42": post() });
    expect(await runCheck([], capture().out, dir)).toBe(0);
  });

  it("exits 1 for an invalid week and prints where and why", async () => {
    const dir = project({ "2026-W42": post().replace("tip", "unknown-pillar") });
    const { lines, out } = capture();
    expect(await runCheck([`--root=${join(dir, "content")}`], out)).toBe(1);
    expect(lines.some((l) => l.startsWith('error 2026-10-12-story-a pillar: "unknown-pillar" is not a pillar in the config'))).toBe(true);
    expect(lines.at(-1)).toMatch(/1 error\(s\)/);
  });

  it("exits 1 when the week is missing the version", async () => {
    const dir = project({ "2026-W42": post().replace("version: 1\n", "") });
    const { lines, out } = capture();
    expect(await runCheck([`--root=${join(dir, "content")}`], out)).toBe(1);
    expect(lines.some((l) => l.includes("version: 1"))).toBe(true);
  });

  it("checks only the requested week and fails when it does not exist", async () => {
    const dir = project({ "2026-W42": post(), "2026-W43": "version: 1\nposts: [" });
    expect(await runCheck([`--root=${join(dir, "content")}`, "2026-W42"], capture().out)).toBe(0);
    const { lines, out } = capture();
    expect(await runCheck([`--root=${join(dir, "content")}`, "2026-W50"], out)).toBe(1);
    expect(lines.at(-1)).toMatch(/week 2026-W50 not found/);
  });

  it("loads the config first: an invalid config fails before any week is read", async () => {
    const dir = project({ "2026-W42": post() });
    writeFileSync(join(dir, "weekpost.config.ts"), CONFIG.replace('timeZone: "Europe/London"', 'timeZone: "Mars/Base"'));
    const { lines, out } = capture();
    expect(await runCheck([`--root=${join(dir, "content")}`], out)).toBe(1);
    expect(lines.join("\n")).toContain("accounts.en.timeZone: Mars/Base is not an IANA time zone");
    expect(lines.join("\n")).not.toContain("week(s)");
  });

  it("fails with a clear message when there is no config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weekpost-empty-"));
    const { lines, out } = capture();
    expect(await runCheck([], out, dir)).toBe(1);
    expect(lines[0]).toContain("weekpost.config.ts not found");
  });
});

describe("weekpost command line", () => {
  const bin = join(import.meta.dirname, "../bin/weekpost.js");
  let dir: string;
  beforeAll(() => {
    dir = project({ "2026-W42": post(), "2026-W43": post().replace("tip", "nope") });
  });

  it("dispatches `check` through bin/weekpost.js and passes the exit code through", () => {
    const ok = execFileSync("node", [bin, "check", "2026-W42", `--root=${join(dir, "content")}`], { encoding: "utf8" });
    expect(ok).toContain("1 week(s), 1 post(s), 0 error(s)");
    const bad = spawnSync("node", [bin, "check", "2026-W43", `--root=${join(dir, "content")}`], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("is not a pillar in the config");
  });

  it("prints usage for no command or an unknown one", async () => {
    expect(await main([])).toBe(2);
    expect(await main(["bogus"])).toBe(2);
    expect(await main(["--help"])).toBe(0);
  });
});
