import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit, templateFiles, type Answers } from "../src/cli/init.ts";
import { buildLock, LOCK_FILE, packageVersion, renderTemplate } from "../src/setup/template.ts";

const ANSWERS: Answers = {
  brandName: "Shop & Co",
  accounts: [{ handle: "shop_en", lang: "en", timeZone: "Europe/London", hemisphere: "north" }],
  pillars: ["tip"],
  cta: ["link in bio"],
  previewLabel: "ok-to-render",
};
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const initIn = async (answers: Answers) => {
  const dir = mkdtempSync(join(tmpdir(), "weekpost-lock-"));
  const f = join(mkdtempSync(join(tmpdir(), "weekpost-ans-")), "a.json");
  writeFileSync(f, JSON.stringify(answers));
  expect(await runInit([dir, `--answers=${f}`], { log: () => {}, error: () => {} })).toBe(0);
  return dir;
};

describe("renderTemplate", () => {
  it("is pure: same answers, same bytes, and one entry per template file", () => {
    const today = new Date("2026-01-02T00:00:00Z");
    const a = renderTemplate(ANSWERS, { today });
    const b = renderTemplate(ANSWERS, { today });
    expect(a.map((f) => f.path)).toEqual(templateFiles());
    expect(a.map((f) => sha(f.content))).toEqual(b.map((f) => sha(f.content)));
  });

  it("fills in the custom preview label and the brand", () => {
    const files = new Map(renderTemplate(ANSWERS).map((f) => [f.path, f.content.toString("utf8")]));
    expect(files.get(".github/workflows/weekpost-preview.yml")).toContain("'ok-to-render'");
    expect(files.get(".github/workflows/weekpost-preview.yml")).not.toContain("media-ok");
    expect(files.get("weekpost.config.ts")).toContain('"Shop & Co"');
  });
});

describe("weekpost.lock.json", () => {
  it("is written by init with the package version and the hash of every file as written to disk", async () => {
    const dir = await initIn(ANSWERS);
    const lock = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8"));
    expect(lock.lockVersion).toBe(1);
    expect(lock.weekpost).toBe(packageVersion());
    expect(Object.keys(lock.files)).toEqual([...templateFiles()].sort());
    for (const [path, hash] of Object.entries(lock.files)) expect(sha(readFileSync(join(dir, path))), path).toBe(hash);
    // A custom label is in the hash: it is not an edit.
    expect(lock.files[".github/workflows/weekpost-preview.yml"]).toBe(sha(readFileSync(join(dir, ".github/workflows/weekpost-preview.yml"))));
  });

  it("does not list itself and ends with a newline", async () => {
    const dir = await initIn(ANSWERS);
    const text = readFileSync(join(dir, LOCK_FILE), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).files[LOCK_FILE]).toBeUndefined();
  });

  it("buildLock sorts paths so the file is stable", () => {
    const lock = buildLock([{ path: "b", content: Buffer.from("1") }, { path: "a", content: Buffer.from("2") }], "9.9.9");
    expect(Object.keys(lock.files)).toEqual(["a", "b"]);
    expect(lock.weekpost).toBe("9.9.9");
  });
});
