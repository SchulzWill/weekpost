import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packArtifact } from "./pack.ts";

const sha = "a".repeat(64);
const manifest = (week: string) => ({
  version: 1, generator: "weekpost@0", week, spentUsd: 0.1, budgetUsd: 5, warnings: [],
  posts: [{
    id: "2026-11-02-tip", type: "carousel", date: "2026-11-02", times: { en: "09:00" }, timeZones: { en: "Europe/London" }, contentHash: sha, coherence: [],
    accounts: { en: { files: ["2026-11-02-tip/en/01.jpg"], publish: ["2026-11-02-tip/en/01.jpg"], caption: "c", sha256: { "2026-11-02-tip/en/01.jpg": sha } } },
  }],
});

function fixture() {
  const out = mkdtempSync(join(tmpdir(), "wp-pack-"));
  const week = join(out, "2026-W45");
  mkdirSync(join(week, "2026-11-02-tip/en"), { recursive: true });
  writeFileSync(join(week, "manifest.json"), JSON.stringify(manifest("2026-W45")));
  writeFileSync(join(week, "index.html"), "<html></html>");
  writeFileSync(join(week, "costs.jsonl"), "{}\n");
  writeFileSync(join(week, "2026-11-02-tip/en/01.jpg"), "jpg");
  writeFileSync(join(week, "2026-11-02-tip/en/scratch.png"), "png");
  return out;
}

describe("packArtifact", () => {
  it("copies the manifest, the preview page and only the files the manifest cites", () => {
    const out = fixture();
    const dest = mkdtempSync(join(tmpdir(), "wp-dest-"));
    const r = packArtifact(out, ["2026-W45"], dest);
    expect(r.packed.map((p) => p.week)).toEqual(["2026-W45"]);
    expect(r.missing).toEqual([]);
    expect(readdirSync(join(dest, "2026-W45")).sort()).toEqual(["2026-11-02-tip", "index.html", "manifest.json"]);
    expect(readdirSync(join(dest, "2026-W45/2026-11-02-tip/en"))).toEqual(["01.jpg"]);
  });

  it("reports a week with no manifest instead of throwing", () => {
    const out = fixture();
    const dest = mkdtempSync(join(tmpdir(), "wp-dest-"));
    const r = packArtifact(out, ["2026-W45", "2026-W46"], dest);
    expect(r.missing).toEqual(["2026-W46"]);
    expect(existsSync(join(dest, "2026-W46"))).toBe(false);
  });

  it("reports a week whose manifest is invalid", () => {
    const out = fixture();
    writeFileSync(join(out, "2026-W45/manifest.json"), "{}");
    const r = packArtifact(out, ["2026-W45"], mkdtempSync(join(tmpdir(), "wp-dest-")));
    expect(r.missing).toEqual(["2026-W45"]);
  });

  it("skips a cited file that does not exist", () => {
    const out = fixture();
    const m = manifest("2026-W45");
    m.posts[0].accounts.en.files.push("2026-11-02-tip/en/02.jpg");
    writeFileSync(join(out, "2026-W45/manifest.json"), JSON.stringify(m));
    const dest = mkdtempSync(join(tmpdir(), "wp-dest-"));
    expect(packArtifact(out, ["2026-W45"], dest).missing).toEqual([]);
    expect(readdirSync(join(dest, "2026-W45/2026-11-02-tip/en"))).toEqual(["01.jpg"]);
  });
});
