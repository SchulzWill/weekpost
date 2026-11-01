// The optional `metrics.extra` hook: a command of the user's that prints extra numbers for the weekly report.
// It runs without a shell (argv, not a string), with a small environment, a time limit and a cap on output and rows.
// It never throws: a failure of any kind comes back as `{ error }`, which the report shows under Attention.
import { spawn } from "node:child_process";
import type { ExtraLine } from "./report.ts";

export const EXTRA_TIMEOUT_MS = 30_000;
export const EXTRA_MAX_ROWS = 10;
const MAX_OUTPUT_BYTES = 64 * 1024;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ExtraResult = { lines: ExtraLine[] } | { error: string };

export interface ExtraInput {
  /** `metrics.extra.command` from the config: program first, then its arguments. */
  command: readonly string[];
  /** Working directory (the project root). */
  cwd: string;
  /** Dotenv text from `WEEKPOST_METRICS_EXTRA_ENV`; becomes the hook's environment. */
  envText?: string;
  from: string;
  to: string;
  accounts: string[];
  /** Tests only. */
  timeoutMs?: number;
}

/** KEY=value lines; `#` comments and blank lines are skipped; one pair of quotes around a value is removed. Never quotes a bad line back. */
export function parseDotenv(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1 || !KEY.test(line.slice(0, eq).trim())) return null;
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

/** Checks the hook's stdout: a JSON array of up to 10 `{ label, value }` with a non-empty text label and a text or finite number value. */
export function parseExtraOutput(stdout: string): ExtraResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { error: 'output is not JSON (expected [{"label": "...", "value": 12}])' };
  }
  if (!Array.isArray(data)) return { error: "output is not a JSON array" };
  if (data.length > EXTRA_MAX_ROWS) return { error: `returned ${data.length} rows (the limit is ${EXTRA_MAX_ROWS})` };
  const lines: ExtraLine[] = [];
  for (const [i, row] of data.entries()) {
    const r = row as { label?: unknown; value?: unknown } | null;
    const okValue = typeof r?.value === "string" || (typeof r?.value === "number" && Number.isFinite(r.value));
    if (typeof r?.label !== "string" || !r.label.trim() || !okValue) return { error: `row ${i + 1} needs a text label and a text or number value` };
    lines.push({ label: r.label, value: r.value as string | number });
  }
  return { lines };
}

export function runExtra(input: ExtraInput): Promise<ExtraResult> {
  const [program, ...args] = input.command;
  if (!program) return Promise.resolve({ error: "metrics.extra.command is empty" });
  const userEnv = input.envText ? parseDotenv(input.envText) : {};
  if (userEnv === null) return Promise.resolve({ error: "WEEKPOST_METRICS_EXTRA_ENV is not valid dotenv text (KEY=value per line)" });
  const timeoutMs = input.timeoutMs ?? EXTRA_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ExtraResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(program, args, {
      cwd: input.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      // Not the caller's whole environment: tokens and database keys stay out of user code.
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...userEnv,
        WEEKPOST_METRICS_FROM: input.from,
        WEEKPOST_METRICS_TO: input.to,
        WEEKPOST_METRICS_ACCOUNTS: input.accounts.join(","),
      },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ error: `timed out after ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);

    let out = "";
    let bytes = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        done({ error: `output is larger than ${MAX_OUTPUT_BYTES / 1024} KiB` });
      } else out += chunk;
    });
    child.on("error", (e) => done({ error: `could not start the command (${(e as NodeJS.ErrnoException).code ?? "error"})` }));
    child.on("close", (code, signal) => {
      if (code !== 0) done({ error: signal ? `stopped by ${signal}` : `exited with code ${code}` });
      else done(parseExtraOutput(out));
    });
  });
}
