import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { forbiddenVars, runAgentEnv } from "./agentEnv.ts";
import { legacyLocalEnvPath, localEnvPath, migrateLocalEnv, readLocalEnv, readSecret, requireTty, SecretError, writeLocalEnv } from "./secrets.ts";
import { main } from "./main.ts";

const SENTINEL = "SENTINEL-s3cr3t-9f8e7d6c";
const capture = () => {
  const lines: string[] = [];
  return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) } };
};
const caught = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("did not throw");
};
const tmp = () => mkdtempSync(join(tmpdir(), "wp-sec-"));

describe("requireTty", () => {
  it("exits 2 with a clear message without a terminal", () => {
    const { lines, out } = capture();
    expect(requireTty("token", out, false)).toBe(2);
    expect(lines.join("\n")).toMatch(/token needs an interactive terminal/);
  });
  it("lets a terminal through, silently", () => {
    const { lines, out } = capture();
    expect(requireTty("token", out, true)).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe("readSecret", () => {
  it("prefers the environment and never asks", async () => {
    const ask = async () => {
      throw new Error("should not ask");
    };
    expect(await readSecret("K", "Key", { env: { K: ` ${SENTINEL} ` }, tty: true, ask })).toBe(SENTINEL);
  });
  it("asks on a terminal when the environment has nothing", async () => {
    let label = "";
    const got = await readSecret("K", "OpenRouter key", { env: {}, tty: true, ask: async (l) => ((label = l), SENTINEL) });
    expect(got).toBe(SENTINEL);
    expect(label).toBe("OpenRouter key");
  });
  it("fails without a terminal, naming the variable and nothing else", async () => {
    const err = (await readSecret("K", "Key", { env: {}, tty: false }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(SecretError);
    expect(err.message).toContain("K is not set");
  });
  it("rejects an empty answer", async () => {
    await expect(readSecret("K", "Key", { env: {}, tty: true, ask: async () => "  " })).rejects.toThrow(/empty/);
  });
});

describe("local secrets file", () => {
  it("names the file after the folder and a short hash of its absolute path", () => {
    const path = localEnvPath("/work/my-app", "/home/u");
    expect(path).toMatch(/^\/home\/u\/\.config\/weekpost\/my-app-[0-9a-f]{8}\.env$/);
    expect(localEnvPath("/work/my-app/", "/home/u")).toBe(path);
    expect(localEnvPath("/work/my-app/../my-app", "/home/u")).toBe(path);
  });
  it("two folders with the same name do not share a file", () => {
    expect(localEnvPath("/clients/a/social", "/h")).not.toBe(localEnvPath("/clients/b/social", "/h"));
  });
  it("accepts a folder with spaces or accents, and never lets the name climb out of the directory", () => {
    for (const root of ["/work/Minha Marca", "/work/Horta Viva ção", "/work/.hidden", "/work/a..b", "/work/-x"]) {
      const path = localEnvPath(root, "/h");
      expect(path).toMatch(/^\/h\/\.config\/weekpost\/[A-Za-z0-9][A-Za-z0-9._-]*-[0-9a-f]{8}\.env$/);
    }
  });
  it("finds the file written under the old name, copies it to the new name once and warns", () => {
    const home = tmp();
    const root = join(tmp(), "my-brand");
    writeLocalEnv(legacyLocalEnvPath(root, home)!, { K: SENTINEL });
    const warnings: string[] = [];
    const path = migrateLocalEnv(root, home, (m) => warnings.push(m));
    expect(path).toBe(localEnvPath(root, home));
    expect(readLocalEnv(path)).toEqual({ K: SENTINEL });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(SENTINEL);
    migrateLocalEnv(root, home, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
  });
  it("does not touch the old file when the new one exists, and does nothing when neither exists", () => {
    const home = tmp();
    const root = join(tmp(), "my-brand");
    const warnings: string[] = [];
    expect(migrateLocalEnv(root, home, (m) => warnings.push(m))).toBe(localEnvPath(root, home));
    writeLocalEnv(legacyLocalEnvPath(root, home)!, { K: "old" });
    writeLocalEnv(localEnvPath(root, home), { K: "new" });
    migrateLocalEnv(root, home, (m) => warnings.push(m));
    expect(readLocalEnv(localEnvPath(root, home))).toEqual({ K: "new" });
    expect(warnings).toHaveLength(0);
  });
  it("writes with mode 0600 in a 0700 directory and reads back", () => {
    const home = tmp();
    const path = localEnvPath("p", home);
    writeLocalEnv(path, { OPENROUTER_API_KEY: SENTINEL });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config/weekpost")).mode & 0o777).toBe(0o700);
    expect(readLocalEnv(path)).toEqual({ OPENROUTER_API_KEY: SENTINEL });
  });
  it("tightens a directory that already existed with a wider mode", () => {
    const home = tmp();
    mkdirSync(join(home, ".config/weekpost"), { recursive: true, mode: 0o755 });
    chmodSync(join(home, ".config/weekpost"), 0o755);
    writeLocalEnv(localEnvPath("p", home), { K: SENTINEL });
    expect(statSync(join(home, ".config/weekpost")).mode & 0o777).toBe(0o700);
  });
  it("does not follow a link planted where the temporary file goes", () => {
    const home = tmp();
    const path = localEnvPath("p", home);
    const outside = join(tmp(), "victim.txt");
    writeFileSync(outside, "untouched");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    symlinkSync(outside, `${path}.${process.pid}.tmp`);
    writeLocalEnv(path, { K: SENTINEL });
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(readLocalEnv(path)).toEqual({ K: SENTINEL });
  });
  it("keeps an equals sign inside the value", () => {
    const path = localEnvPath("p", tmp());
    writeLocalEnv(path, { A_B: "x=y==" });
    expect(readLocalEnv(path)).toEqual({ A_B: "x=y==" });
  });
  it("refuses to read a file wider than 0600, without exposing the content", () => {
    const path = localEnvPath("p", tmp());
    writeLocalEnv(path, { K: SENTINEL });
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      chmodSync(path, mode);
      const err = caught(() => readLocalEnv(path));
      expect(err).toBeInstanceOf(SecretError);
      expect(err.message).toContain("chmod 600");
      expect(err.message).not.toContain(SENTINEL);
    }
  });
  it("refuses a symlink, a missing file and a malformed line without echoing the value", () => {
    const dir = tmp();
    const real = join(dir, "real.env");
    writeFileSync(real, `NOT A LINE ${SENTINEL}\n`, { mode: 0o600 });
    const link = join(dir, "link.env");
    symlinkSync(real, link);
    expect(() => readLocalEnv(link)).toThrow(SecretError);
    expect(() => readLocalEnv(join(dir, "none.env"))).toThrow(/does not exist/);
    const err = caught(() => readLocalEnv(real));
    expect(err.message).toMatch(/malformed/);
    expect(err.message).not.toContain(SENTINEL);
  });
  it("rejects values that would break the file format", () => {
    const path = localEnvPath("p", tmp());
    expect(() => writeLocalEnv(path, { K: `a\nB=${SENTINEL}` })).toThrow(SecretError);
    expect(() => writeLocalEnv(path, { "bad key": "x" })).toThrow(SecretError);
  });
  it("the file holds the value only where it should", () => {
    const path = localEnvPath("p", tmp());
    writeLocalEnv(path, { K: SENTINEL });
    expect(readFileSync(path, "utf8")).toBe(`K=${SENTINEL}\n`);
  });
});

describe("agent-env", () => {
  it("passes on a clean environment", () => {
    const { lines, out } = capture();
    expect(runAgentEnv([], out, { PATH: "/bin", OPENROUTER_API_KEY: "x" })).toBe(0);
    expect(lines.join("\n")).toContain("clean");
  });
  it("exits 1 for each forbidden family and prints names only", () => {
    for (const name of ["WEEKPOST_SUPABASE_URL", "WEEKPOST_SUPABASE_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "DATABASE_URL"]) {
      const { lines, out } = capture();
      expect(runAgentEnv([], out, { [name]: SENTINEL })).toBe(1);
      const text = lines.join("\n");
      expect(text).toContain(name);
      expect(text).not.toContain(SENTINEL);
    }
  });
  it("ignores empty values and lists every offender sorted", () => {
    expect(forbiddenVars({ DATABASE_URL: "", CLOUDFLARE_X: "1", WEEKPOST_SUPABASE_URL: "1" })).toEqual(["CLOUDFLARE_X", "WEEKPOST_SUPABASE_URL"]);
  });
  it("is wired into the dispatcher", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = SENTINEL;
    const lines: string[] = [];
    const log = console.log, err = console.error;
    console.log = (l: string) => lines.push(String(l));
    console.error = (l: string) => lines.push(String(l));
    try {
      expect(await main(["agent-env"])).toBe(1);
    } finally {
      console.log = log;
      console.error = err;
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
    expect(lines.join("\n")).not.toContain(SENTINEL);
  });
});
