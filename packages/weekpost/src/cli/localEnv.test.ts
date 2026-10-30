import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testConfig } from "../content/fixtures.ts";
import { runFirstPost } from "./firstPost.ts";
import { runStatus } from "./status.ts";
import { runCancel } from "./cancel.ts";
import { legacyLocalEnvPath, localEnvPath, withLocalEnv, writeLocalEnv } from "./secrets.ts";

const KEY_FILE = "sb_secret_SENTINEL-from-file-1a2b3c";
const KEY_ENV = "sb_secret_SENTINEL-from-env-9z8y7x";
const URL_FILE = "https://file-project.example.test";

/** A fake home with ~/.config/weekpost/<project>.env, and the project folder named <project>. */
function fixture(project = "my-brand") {
  const home = mkdtempSync(join(tmpdir(), "wp-home-"));
  const cwd = join(mkdtempSync(join(tmpdir(), "wp-proj-")), project);
  mkdirSync(cwd);
  writeLocalEnv(localEnvPath(cwd, home), { WEEKPOST_SUPABASE_URL: URL_FILE, WEEKPOST_SUPABASE_KEY: KEY_FILE });
  return { home, cwd };
}

/** Replaces the global fetch with one that records the request and fails, so no command goes any further. */
function spyFetch() {
  const seen: { url: string; apikey: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), apikey: (init?.headers as Record<string, string>)?.apikey ?? "" });
    throw new Error("network blocked in test");
  });
  return seen;
}
const sink = () => ({ out: { log: () => {}, error: () => {} } });

afterEach(() => vi.unstubAllGlobals());

describe("withLocalEnv", () => {
  it("fills missing variables from the file; the environment wins", () => {
    const { home, cwd } = fixture();
    expect(withLocalEnv({}, cwd, home)).toMatchObject({ WEEKPOST_SUPABASE_URL: URL_FILE, WEEKPOST_SUPABASE_KEY: KEY_FILE });
    expect(withLocalEnv({ WEEKPOST_SUPABASE_KEY: KEY_ENV }, cwd, home)).toMatchObject({ WEEKPOST_SUPABASE_URL: URL_FILE, WEEKPOST_SUPABASE_KEY: KEY_ENV });
  });
  it("two folders named alike do not read each other's file", () => {
    const { home, cwd } = fixture("social");
    const other = join(mkdtempSync(join(tmpdir(), "wp-proj-")), "social");
    mkdirSync(other);
    expect(withLocalEnv({}, other, home)).toEqual({});
    expect(withLocalEnv({}, cwd, home)).toMatchObject({ WEEKPOST_SUPABASE_KEY: KEY_FILE });
  });
  it("still reads a file written under the old name, and migrates it", () => {
    const home = mkdtempSync(join(tmpdir(), "wp-home-"));
    const cwd = join(mkdtempSync(join(tmpdir(), "wp-proj-")), "my-brand");
    mkdirSync(cwd);
    writeLocalEnv(legacyLocalEnvPath(cwd, home)!, { WEEKPOST_SUPABASE_URL: URL_FILE, WEEKPOST_SUPABASE_KEY: KEY_FILE });
    expect(withLocalEnv({}, cwd, home)).toMatchObject({ WEEKPOST_SUPABASE_KEY: KEY_FILE });
    expect(existsSync(localEnvPath(cwd, home))).toBe(true);
  });
  it("ignores a missing file", () => {
    const { cwd } = fixture();
    const empty = mkdtempSync(join(tmpdir(), "wp-home-"));
    expect(withLocalEnv({ A: "1" }, cwd, empty)).toEqual({ A: "1" });
  });
});

describe("queue commands and first-post read the local secrets file", () => {
  it("first-post connects with the file's URL and key when the environment has none", async () => {
    const { home, cwd } = fixture();
    const seen = spyFetch();
    await runFirstPost(["en", "--caption=Hi", "--yes"], sink().out, cwd, { config: testConfig(), tty: true, env: {}, home });
    expect(seen[0]?.url.startsWith(URL_FILE)).toBe(true);
    expect(seen[0]?.apikey).toBe(KEY_FILE);
  });
  it("first-post: the environment beats the file", async () => {
    const { home, cwd } = fixture();
    const seen = spyFetch();
    await runFirstPost(["en", "--caption=Hi", "--yes"], sink().out, cwd, {
      config: testConfig(), tty: true, home, env: { WEEKPOST_SUPABASE_URL: "https://env-project.example.test", WEEKPOST_SUPABASE_KEY: KEY_ENV },
    });
    expect(seen[0]?.url.startsWith("https://env-project.example.test")).toBe(true);
    expect(seen[0]?.apikey).toBe(KEY_ENV);
  });
  it("status (and so cancel, reschedule, resolve, restore) connects with the file's secrets", async () => {
    const { home, cwd } = fixture();
    const seen = spyFetch();
    await runStatus([], sink().out, cwd, { zones: { en: "UTC" }, env: {}, home });
    expect(seen[0]?.url.startsWith(URL_FILE)).toBe(true);
    expect(seen[0]?.apikey).toBe(KEY_FILE);
  });
  it("writing commands read the file only with a terminal; without one they need the environment and say so", async () => {
    const { home, cwd } = fixture();
    const seen = spyFetch();
    const lines: string[] = [];
    const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    expect(await runCancel(["2026-11-02-tip", "--yes"], out, cwd, { zones: { en: "UTC" }, env: {}, home, tty: false })).toBe(1);
    expect(seen).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/environment/);
    expect(lines.join("\n")).not.toContain(KEY_FILE);
    await runCancel(["2026-11-02-tip", "--yes"], out, cwd, { zones: { en: "UTC" }, env: {}, home, tty: true });
    expect(seen[0]?.apikey).toBe(KEY_FILE);
  });
  it("without a terminal, withLocalEnv for a writing command ignores the file; the environment still works", () => {
    const { home, cwd } = fixture();
    expect(withLocalEnv({}, cwd, home, { tty: false })).toEqual({});
    expect(withLocalEnv({ A: "1" }, cwd, home, { tty: false })).toEqual({ A: "1" });
    expect(withLocalEnv({}, cwd, home, { tty: true })).toMatchObject({ WEEKPOST_SUPABASE_KEY: KEY_FILE });
  });
  it("never prints the secret from the file when the call fails", async () => {
    const { home, cwd } = fixture();
    spyFetch();
    const lines: string[] = [];
    await runStatus([], { log: (l) => lines.push(l), error: (l) => lines.push(l) }, cwd, { zones: { en: "UTC" }, env: {}, home });
    expect(lines.join("\n")).not.toContain(KEY_FILE);
  });
});
