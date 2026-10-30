// Runs an external program (gh, npx wrangler, ...). Every command in src/setup goes through a `Runner`, so tests
// inject a fake and nothing in the test suite touches a real CLI or the network.
import { spawn } from "node:child_process";

export type RunResult = { status: number | null; stdout: string; stderr: string };

export type RunOptions = {
  cwd?: string;
  /** Written to the program's stdin, then stdin is closed. This is how a secret value reaches `wrangler` and `gh`: never in argv. */
  input?: string;
  timeoutMs?: number;
};

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** The real runner: no shell (arguments are never interpreted), output captured, killed after the timeout. */
export const spawnRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ status: null, stdout, stderr: `${stderr}\ntimed out` });
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) => done({ status: null, stdout, stderr: String(e.message) }));
    child.on("close", (code) => done({ status: code, stdout, stderr }));
    child.stdin.on("error", () => {}); // the program may exit before reading its stdin
    child.stdin.end(opts.input ?? "");
  });

/** `wrangler` is not a dependency of the project: run it through npx, pinned to the current major. */
export const WRANGLER_PKG = "wrangler@4";
