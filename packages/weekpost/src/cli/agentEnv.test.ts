import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentEnv } from "./agentEnv.ts";
import { legacyLocalEnvPath, localEnvPath, writeLocalEnv } from "./secrets.ts";

const SENTINEL = "sb_secret_SENTINEL-agent-env-4d5e6f";

function fixture(withFile: boolean) {
  const home = mkdtempSync(join(tmpdir(), "wp-home-"));
  const root = join(mkdtempSync(join(tmpdir(), "wp-proj-")), "my-brand");
  mkdirSync(root);
  if (withFile) writeLocalEnv(localEnvPath(root, home), { WEEKPOST_SUPABASE_KEY: SENTINEL });
  const lines: string[] = [];
  const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  return { home, root, lines, out };
}

describe("agent-env", () => {
  it("is clean with an empty environment and no local secrets file", () => {
    const f = fixture(false);
    expect(runAgentEnv([`--project=${f.root}`], f.out, {}, f.home, f.root)).toBe(0);
  });
  it("fails when the local secrets file exists and is readable, and explains the way out", () => {
    const f = fixture(true);
    expect(runAgentEnv([], f.out, {}, f.home, f.root)).toBe(1);
    const text = f.lines.join("\n");
    expect(text).toMatch(/sandbox|another (system )?user/i);
    expect(text).not.toContain(SENTINEL);
  });
  it("fails too when only the file under the old name exists", () => {
    const f = fixture(false);
    writeLocalEnv(legacyLocalEnvPath(f.root, f.home)!, { WEEKPOST_SUPABASE_KEY: SENTINEL });
    expect(runAgentEnv([], f.out, {}, f.home, f.root)).toBe(1);
  });
  it("still fails on secrets in the environment", () => {
    const f = fixture(false);
    expect(runAgentEnv([], f.out, { WEEKPOST_SUPABASE_KEY: SENTINEL }, f.home, f.root)).toBe(1);
    expect(f.lines.join("\n")).not.toContain(SENTINEL);
  });
});
