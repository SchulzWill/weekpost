import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCi } from "./ci.ts";

const capture = () => {
  const lines: string[] = [];
  return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) } };
};
const tmp = () => mkdtempSync(join(tmpdir(), "wp-ci-"));
const sha = "a".repeat(64);
const manifest = (week: string) => ({
  version: 1, generator: "w", week, spentUsd: 0.25, budgetUsd: 5, warnings: [{ level: "warn", where: "p", message: "m" }],
  posts: [{ id: "2026-11-02-tip", type: "story", date: "2026-11-02", times: { en: "09:00" }, timeZones: { en: "Europe/London" }, contentHash: sha, coherence: [],
    accounts: { en: { files: ["2026-11-02-tip/en/story.jpg"], publish: ["2026-11-02-tip/en/story.jpg"], caption: "c", sha256: { "2026-11-02-tip/en/story.jpg": sha } } } }],
});

describe("weekpost ci", () => {
  it("rejects unknown subcommands with the usage", async () => {
    const { lines, out } = capture();
    expect(await runCi(["nope"], out)).toBe(2);
    expect(lines.join("\n")).toContain("usage: weekpost ci");
  });

  it("pack copies the weeks listed in the file", async () => {
    const root = tmp();
    mkdirSync(join(root, "out/2026-W45/2026-11-02-tip/en"), { recursive: true });
    writeFileSync(join(root, "out/2026-W45/manifest.json"), JSON.stringify(manifest("2026-W45")));
    writeFileSync(join(root, "out/2026-W45/2026-11-02-tip/en/story.jpg"), "x");
    writeFileSync(join(root, "weeks.txt"), "2026-W45\n2026-W46\n");
    const { lines, out } = capture();
    expect(await runCi(["pack", "weeks.txt", "dest"], out, root)).toBe(0);
    expect(readFileSync(join(root, "dest/2026-W45/manifest.json"), "utf8")).toContain("2026-W45");
    expect(lines.join("\n")).toContain("no preview for 2026-W46");
  });

  it("comment preview writes the body to --out", async () => {
    const root = tmp();
    mkdirSync(join(root, "art/2026-W45"), { recursive: true });
    writeFileSync(join(root, "art/2026-W45/manifest.json"), JSON.stringify(manifest("2026-W45")));
    writeFileSync(join(root, "weeks.txt"), "2026-W45\n2026-W46\n");
    const { out } = capture();
    const code = await runCi(["comment", "preview", "art", "weeks.txt", "--pr=7", "--sha=abcdef012", "--run-url=https://x/r", "--generation-failed", "--out=body.md"], out, root);
    expect(code).toBe(0);
    const body = readFileSync(join(root, "body.md"), "utf8");
    expect(body).toContain("US$0.25 of US$5.00");
    expect(body).toContain("Generation failed");
    expect(body).toContain("npx weekpost preview 7");
  });

  it("comment enqueue ok reads the summary file", async () => {
    const root = tmp();
    writeFileSync(join(root, "s.json"), JSON.stringify({ scheduled: 2, updated: 0, skipped: [], canceled: [] }));
    const { lines, out } = capture();
    expect(await runCi(["comment", "enqueue", "--status=ok", "--summary=s.json", "--run-url=u"], out, root)).toBe(0);
    expect(lines.join("\n")).toContain("Scheduled 2 posts, 0 skipped");
  });

  it("comment enqueue failed keeps the error lines of the log", async () => {
    const root = tmp();
    writeFileSync(join(root, "l.log"), "noise\nerror 2026-W45: hash differs\nnothing was scheduled\n");
    const { lines, out } = capture();
    expect(await runCi(["comment", "enqueue", "--status=failed", "--log=l.log", "--run-url=u"], out, root)).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("hash differs");
    expect(text).not.toContain("noise");
  });

  it("comment enqueue no-preview falls back to the default label without a config", async () => {
    const { lines, out } = capture();
    expect(await runCi(["comment", "enqueue", "--status=no-preview", "--run-url=u"], out, tmp())).toBe(0);
    expect(lines.join("\n")).toContain("`media-ok`");
  });

  it("comment enqueue ok without a readable summary is an error", async () => {
    const { out } = capture();
    expect(await runCi(["comment", "enqueue", "--status=ok", "--summary=missing.json", "--run-url=u"], out, tmp())).toBe(1);
  });
});
