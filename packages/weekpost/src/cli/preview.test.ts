import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findIndexes, runPreview } from "./preview.ts";

// A fake `gh` first in PATH: records its arguments and answers from env vars. No network.
const FAKE_GH = `#!/bin/sh
echo "$@" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "pr view") [ "$FAKE_GH_PR" = fail ] && { echo "no pull requests found" >&2; exit 1; }; echo "feature/week" ;;
  "run list") echo "$FAKE_GH_RUN" ;;
  "run download")
    [ "$FAKE_GH_DOWNLOAD" = fail ] && { echo "artifact expired" >&2; exit 1; }
    while [ $# -gt 0 ]; do [ "$1" = "-D" ] && dest="$2"; shift; done
    mkdir -p "$dest/out/2026-W42" && echo "<html></html>" > "$dest/out/2026-W42/index.html" ;;
esac
`;

describe("weekpost preview", () => {
  let dir: string;
  let log: string;
  const capture = () => {
    const lines: string[] = [];
    return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) } };
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "weekpost-preview-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), FAKE_GH);
    chmodSync(join(bin, "gh"), 0o755);
    log = join(dir, "gh.log");
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("FAKE_GH_LOG", log);
    vi.stubEnv("FAKE_GH_RUN", "9876");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("downloads the artifact of the latest successful run and opens its index.html", async () => {
    const opened: string[] = [];
    const { lines, out } = capture();
    expect(await runPreview(["12", "--repo=me/site"], out, dir, (f) => opened.push(f))).toBe(0);
    const index = join(dir, "out", "preview-12", "out", "2026-W42", "index.html");
    expect(existsSync(index)).toBe(true);
    expect(opened).toEqual([index]);
    expect(lines).toEqual([index]);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("pr view 12 -R me/site");
    expect(calls).toContain("run list -R me/site --workflow weekpost-preview.yml --branch feature/week --status success");
    expect(calls).toContain("run download 9876 -R me/site -n weekpost-preview -D " + join(dir, "out", "preview-12"));
  });

  it("does not open anything with --no-open", async () => {
    const opened: string[] = [];
    expect(await runPreview(["12", "--no-open", "--dest=here"], capture().out, dir, (f) => opened.push(f))).toBe(0);
    expect(opened).toEqual([]);
    expect(existsSync(join(dir, "here", "out", "2026-W42", "index.html"))).toBe(true);
  });

  it("explains when there is no successful preview run", async () => {
    vi.stubEnv("FAKE_GH_RUN", "");
    const { lines, out } = capture();
    expect(await runPreview(["12"], out, dir, () => {})).toBe(1);
    expect(lines[0]).toContain("no successful preview run for PR #12");
  });

  it("reports gh errors for the pull request and for an expired artifact", async () => {
    vi.stubEnv("FAKE_GH_PR", "fail");
    const a = capture();
    expect(await runPreview(["12"], a.out, dir, () => {})).toBe(1);
    expect(a.lines[0]).toContain("no pull requests found");
    vi.stubEnv("FAKE_GH_PR", "");
    vi.stubEnv("FAKE_GH_DOWNLOAD", "fail");
    const b = capture();
    expect(await runPreview(["12"], b.out, dir, () => {})).toBe(1);
    expect(b.lines[0]).toContain("artifact expired");
    expect(b.lines[0]).toContain("re-apply the preview label");
  });

  it("says how to install gh when it is not on the PATH", async () => {
    vi.stubEnv("PATH", join(dir, "empty"));
    const { lines, out } = capture();
    expect(await runPreview(["12"], out, dir, () => {})).toBe(1);
    expect(lines[0]).toContain("GitHub CLI (gh) was not found");
  });

  it("prints usage for a missing or non-numeric PR", async () => {
    for (const args of [[], ["abc"], ["--no-open"]]) {
      const { lines, out } = capture();
      expect(await runPreview(args, out, dir)).toBe(2);
      expect(lines[0]).toContain("usage: weekpost preview");
    }
  });
});

describe("findIndexes", () => {
  it("finds index.html files a few levels down, in name order", () => {
    const dir = mkdtempSync(join(tmpdir(), "weekpost-find-"));
    for (const w of ["b", "a"]) {
      mkdirSync(join(dir, w));
      writeFileSync(join(dir, w, "index.html"), "");
    }
    expect(findIndexes(dir)).toEqual([join(dir, "a", "index.html"), join(dir, "b", "index.html")]);
  });
});
