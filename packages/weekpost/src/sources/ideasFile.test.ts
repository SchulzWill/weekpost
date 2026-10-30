import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blameDates, ideasFile, parseIdeas } from "./ideasFile.ts";

const Q = { week: "2026-W44", from: "2026-10-19T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z", limit: 20 };
const FILE = `# Ideas

- Cold showers and focus — https://example.com/a
* Another one – https://example.com/b
- Hyphen separator - https://example.com/c
- No link here
- Plain http — http://example.com/d
Not a list item — https://example.com/e
- Title only —
`;

describe("parseIdeas", () => {
  it("reads '- title — https://…' lines (em dash, en dash or spaced hyphen) with their line numbers", () => {
    expect(parseIdeas(FILE)).toEqual([
      { line: 3, title: "Cold showers and focus", url: "https://example.com/a" },
      { line: 4, title: "Another one", url: "https://example.com/b" },
      { line: 5, title: "Hyphen separator", url: "https://example.com/c" },
    ]);
  });
});

describe("ideasFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-ideas-"));
  writeFileSync(join(dir, "ideas.md"), FILE);
  const dates: Record<number, string> = { 3: "2026-10-20T09:00:00Z", 4: "2026-10-10T09:00:00Z", 5: "2026-10-25T23:59:59Z" };
  const adapter = ideasFile({ path: "ideas.md" }, { lineDates: () => dates });

  it("is named and takes the date of each line's commit", async () => {
    expect(adapter.name).toBe("ideasFile");
    const items = await adapter.pull(Q, { projectDir: dir, env: {} });
    expect(items.map((i) => [i.title, i.publishedAt])).toEqual([
      ["Cold showers and focus", "2026-10-20T09:00:00.000Z"],
      ["Hyphen separator", "2026-10-25T23:59:59.000Z"],
    ]);
  });
  it("gives stable ids that depend on the URL", async () => {
    const a = await adapter.pull(Q, { projectDir: dir, env: {} });
    const b = await adapter.pull(Q, { projectDir: dir, env: {} });
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(new Set(a.map((i) => i.id)).size).toBe(a.length);
  });
  it("treats a line without a known date as new (now), so it is outside past weeks", async () => {
    const later = ideasFile({ path: "ideas.md" }, { lineDates: () => ({}), now: () => new Date("2026-11-02T00:00:00Z") });
    expect(await later.pull(Q, { projectDir: dir, env: {} })).toEqual([]);
  });
  it("fails with the path when the file is missing", async () => {
    await expect(ideasFile({ path: "nope.md" }, { lineDates: () => ({}) }).pull(Q, { projectDir: dir, env: {} })).rejects.toThrow(/nope\.md/);
  });
  it("refuses a path outside the project", async () => {
    await expect(ideasFile({ path: "../x.md" }, { lineDates: () => ({}) }).pull(Q, { projectDir: dir, env: {} })).rejects.toThrow(/inside the project/);
  });
});

describe("blameDates", () => {
  it("reads the commit date of each line from git, and ignores uncommitted lines", () => {
    const repo = mkdtempSync(join(tmpdir(), "wp-blame-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-20T09:00:00Z", GIT_COMMITTER_DATE: "2026-10-20T09:00:00Z" } });
    git("init", "-q");
    writeFileSync(join(repo, "i.md"), "- one — https://example.com/1\n");
    git("add", "i.md");
    git("commit", "-q", "-m", "x");
    writeFileSync(join(repo, "i.md"), "- one — https://example.com/1\n- two — https://example.com/2\n");
    expect(blameDates(join(repo, "i.md"))).toEqual({ 1: "2026-10-20T09:00:00.000Z" });
  });
  it("is empty outside a git repository", () => {
    const d = mkdtempSync(join(tmpdir(), "wp-nogit-"));
    writeFileSync(join(d, "i.md"), "- one — https://example.com/1\n");
    expect(blameDates(join(d, "i.md"))).toEqual({});
  });
});

describe("ideasFile and symlinks", () => {
  it("refuses an ideas file that is a link to a file outside the project", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wp-outside-"));
    writeFileSync(join(outside, "other.md"), "- elsewhere — https://example.com/else\n");
    const project = mkdtempSync(join(tmpdir(), "wp-proj-"));
    symlinkSync(join(outside, "other.md"), join(project, "ideas.md"));
    const adapter = ideasFile({ path: "ideas.md" }, { lineDates: () => ({ 1: "2026-10-20T09:00:00Z" }) });
    await expect(adapter.pull(Q, { projectDir: project, env: {} })).rejects.toThrow(/inside the project/);
  });
});
