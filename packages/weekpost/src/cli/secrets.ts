// Security base for the commands that write outside the repository: the terminal guard, the secret reader and
// the local secrets file. A secret value is never printed, logged or put in an error message from this module.
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Out } from "./check.ts";

export class SecretError extends Error {}

export const hasTty = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Returns exit code 2 (after saying why) when there is no terminal; null when it is fine to go on. */
export function requireTty(command: string, out: Out, tty: boolean = hasTty()): 2 | null {
  if (tty) return null;
  out.error(`${command} needs an interactive terminal and refuses to run without one (an agent shell is not a terminal). Run it yourself in a terminal.`);
  return 2;
}

export type SecretDeps = {
  env?: Record<string, string | undefined>;
  tty?: boolean;
  /** Hidden prompt. Default: reads a line from the terminal without echoing it. */
  ask?: (label: string) => Promise<string>;
};

async function hiddenPrompt(label: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = new Promise<string>((resolve) => rl.question(`${label}: `, resolve));
    muted = true; // the question text is already written; whatever is typed from here on is not echoed
    return await answer;
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

/** The value of a secret: from the environment, else from a hidden prompt when there is a terminal, else an error. */
export async function readSecret(name: string, label: string, deps: SecretDeps = {}): Promise<string> {
  const fromEnv = (deps.env ?? process.env)[name]?.trim();
  if (fromEnv) return fromEnv;
  if (!(deps.tty ?? hasTty())) throw new SecretError(`${name} is not set and there is no terminal to ask on; set ${name} in the environment`);
  const typed = (await (deps.ask ?? hiddenPrompt)(label)).trim();
  if (!typed) throw new SecretError(`${name} was empty`);
  return typed;
}

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The folder name made safe for a file name: letters, digits, dot, dash, underscore; at most 40 characters. */
function folderLabel(projectRoot: string): string {
  const label = basename(resolve(projectRoot)).normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").replace(/\.{2,}/g, ".").slice(0, 40);
  return label || "project";
}

/**
 * ~/.config/weekpost/<folder>-<hash>.env. The hash is the first 8 hex digits of the SHA-256 of the project's absolute
 * path, so two folders with the same name (`~/a/social`, `~/b/social`) never share secrets.
 */
export function localEnvPath(projectRoot: string, home: string = homedir()): string {
  const root = resolve(projectRoot);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return join(home, ".config", "weekpost", `${folderLabel(root)}-${hash}.env`);
}

/** The name used before the hash: ~/.config/weekpost/<folder>.env. Null when the folder name was not a valid project name. */
export function legacyLocalEnvPath(projectRoot: string, home: string = homedir()): string | null {
  const name = basename(resolve(projectRoot));
  return PROJECT.test(name) && !name.includes("..") ? join(home, ".config", "weekpost", `${name}.env`) : null;
}

/**
 * The path of the project's local secrets file, after moving a file written under the old name. The old file is copied
 * (not moved), because another project with the same folder name may still be using it; the warning says to delete it.
 */
export function migrateLocalEnv(projectRoot: string, home: string = homedir(), warn: (message: string) => void = (m) => process.stderr.write(`${m}\n`)): string {
  const path = localEnvPath(projectRoot, home);
  const legacy = legacyLocalEnvPath(projectRoot, home);
  if (!legacy) return path;
  try {
    readLocalEnv(path);
    return path; // the new file is there: leave the old one alone
  } catch {
    /* missing, or not trustworthy: look for the old one */
  }
  let values: Record<string, string>;
  try {
    values = readLocalEnv(legacy);
  } catch {
    return path;
  }
  try {
    writeLocalEnv(path, values);
  } catch {
    return path;
  }
  warn(`weekpost: copied the local secrets file ${legacy} to ${path} (files are now named after the project's full path). Delete the old one once no other project with the same folder name needs it.`);
  return path;
}

const KEY = /^[A-Z][A-Z0-9_]*$/;

/** Writes the file with mode 0600 (directory 0700), through a temporary file so it is never readable by others. */
export function writeLocalEnv(path: string, values: Record<string, string>): void {
  const lines = Object.entries(values).map(([k, v]) => {
    if (!KEY.test(k)) throw new SecretError(`invalid variable name "${k}"`);
    if (/[\r\n]/.test(v)) throw new SecretError(`the value of ${k} has a line break`);
    return `${k}=${v}`;
  });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700); // mkdir leaves a directory that already existed as it was
  // Unpredictable name, and "wx" fails instead of following a link or reusing a file someone planted there.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Reads the file. Refuses (without printing its content) when it is not a regular file of ours or its mode is wider than 0600. */
export function readLocalEnv(path: string): Record<string, string> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new SecretError(code === "ENOENT" ? `${path} does not exist` : `cannot open ${path} (${code ?? "error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SecretError(`${path} is not a regular file`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new SecretError(`${path} belongs to another user`);
    if (st.mode & 0o077) throw new SecretError(`${path} has mode ${(st.mode & 0o777).toString(8)}; run: chmod 600 ${path}`);
    const result: Record<string, string> = {};
    for (const raw of readFileSync(fd, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1 || !KEY.test(line.slice(0, eq))) throw new SecretError(`${path} has a malformed line`); // never quote the line
      result[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return result;
  } finally {
    closeSync(fd);
  }
}

/**
 * The environment completed with ~/.config/weekpost/<folder>-<hash>.env (named after the project folder and a hash of its path). The environment
 * wins over the file. A missing or unreadable file is ignored: the caller's own connection error names the variables.
 *
 * `access.tty` marks a command that writes (cancel, reschedule, resolve, restore, first-post, enqueue, token): it reads
 * the file only when there is a terminal. Without one (an agent shell, CI) the environment is all it gets.
 * Read-only commands (status, doctor) pass no `access` and always read the file.
 */
export function withLocalEnv(
  env: Record<string, string | undefined>,
  projectRoot: string,
  home: string = homedir(),
  access: { tty: boolean } | undefined = undefined,
): Record<string, string | undefined> {
  if (env.WEEKPOST_SUPABASE_URL && env.WEEKPOST_SUPABASE_KEY) return env;
  if (access && !access.tty) return env;
  try {
    return { ...readLocalEnv(migrateLocalEnv(projectRoot, home)), ...env };
  } catch {
    return env;
  }
}

/** Added to the connection error of a writing command that found no credentials and had no terminal to read the file on. */
export const NO_TTY_ENV_HINT =
  "without a terminal, writing commands do not read the local secrets file; set WEEKPOST_SUPABASE_URL and WEEKPOST_SUPABASE_KEY in the environment (CI provides them)";
