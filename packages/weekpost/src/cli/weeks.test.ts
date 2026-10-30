import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedWeeks, runWeeks } from "./weeks.ts";

describe("changedWeeks", () => {
  it("returns the weeks under content/ the paths touch, sorted and without repeats", () => {
    expect(
      changedWeeks([
        "content/2026-W43/posts.yaml",
        "content/2026-W42/posts.yaml",
        "content/2026-W42/photo.jpg",
        "content/README.md",
        "src/other.ts",
        "weekpost.config.ts",
        "examples/content/2026-W41/posts.yaml",
      ]),
    ).toEqual(["2026-W42", "2026-W43"]);
  });

  it("ignores folders that are not an ISO week", () => {
    expect(changedWeeks(["content/drafts/x.yaml", "content/2026-42/posts.yaml", "content/2026-W4/posts.yaml"])).toEqual([]);
  });
});

describe("runWeeks", () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) } };
  };

  it("writes one week per line, with a final newline, to the out file", () => {
    const dir = mkdtempSync(join(tmpdir(), "weekpost-weeks-"));
    writeFileSync(join(dir, "paths.txt"), "content/2026-W43/posts.yaml\ncontent/2026-W42/a.jpg\n");
    const { lines, out } = capture();
    expect(runWeeks(["paths.txt", "weeks.txt"], out, dir)).toBe(0);
    expect(readFileSync(join(dir, "weeks.txt"), "utf8")).toBe("2026-W42\n2026-W43\n");
    expect(lines).toEqual(["weeks: 2026-W42, 2026-W43"]);
  });

  it("prints to the output without an out file, and writes an empty file when nothing matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "weekpost-weeks-"));
    writeFileSync(join(dir, "paths.txt"), "README.md\ncontent/2026-W42/posts.yaml\n");
    const a = capture();
    expect(runWeeks(["paths.txt"], a.out, dir)).toBe(0);
    expect(a.lines).toEqual(["2026-W42"]);
    writeFileSync(join(dir, "none.txt"), "README.md\n");
    const b = capture();
    expect(runWeeks(["none.txt", "w.txt"], b.out, dir)).toBe(0);
    expect(readFileSync(join(dir, "w.txt"), "utf8")).toBe("");
    expect(b.lines).toEqual(["no week under content/ changed"]);
  });

  it("fails on a missing argument or a missing file", () => {
    expect(runWeeks([], capture().out)).toBe(2);
    const { lines, out } = capture();
    expect(runWeeks(["nope.txt"], out, tmpdir())).toBe(1);
    expect(lines[0]).toContain("cannot read nope.txt");
  });
});
