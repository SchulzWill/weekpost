// The optional `metrics.extra` hook: an async function in `weekpost.config.ts` that returns extra numbers for the weekly report.
// It is the user's own code, trusted like the rest of the config, so it runs in-process. It gets a time limit and its rows are checked.
// It never throws: a failure comes back as `error`, and unusable rows as `warnings`; the report shows both under Attention.
import type { ExtraLine } from "./report.ts";

export const EXTRA_TIMEOUT_MS = 30_000;
export const EXTRA_MAX_ROWS = 10;
export const EXTRA_MAX_LABEL = 60;
export const EXTRA_MAX_VALUE = 120;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ExtraContext {
  /** ISO start of the window (7 days before the run). */
  from: string;
  /** ISO end of the window (the run). */
  to: string;
  accounts: string[];
  /** Parsed from the optional `WEEKPOST_METRICS_EXTRA_ENV` secret (dotenv text); `{}` without it. */
  env: Record<string, string>;
  /** Aborted when the hook times out. */
  signal: AbortSignal;
}

export type ExtraHook = (ctx: ExtraContext) => Promise<unknown> | unknown;

export type ExtraResult = { lines: ExtraLine[]; warnings: string[] } | { error: string };

export interface ExtraInput {
  hook: ExtraHook;
  /** Dotenv text from `WEEKPOST_METRICS_EXTRA_ENV`. */
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

/** Checks what the hook returned. Not an array is an error; a bad row is dropped with a warning; rows past 10 are cut with a warning. */
export function checkExtraRows(data: unknown): ExtraResult {
  if (!Array.isArray(data)) return { error: "the hook did not return an array of { label, value }" };
  const warnings: string[] = [];
  const lines: ExtraLine[] = [];
  for (const [i, row] of data.entries()) {
    const r = row as { label?: unknown; value?: unknown } | null;
    const where = `row ${i + 1}`;
    const okValue = typeof r?.value === "string" || (typeof r?.value === "number" && Number.isFinite(r.value));
    if (typeof r?.label !== "string" || !r.label.trim() || !okValue) warnings.push(`${where} dropped: it needs a text label and a text or number value`);
    else if (r.label.length > EXTRA_MAX_LABEL) warnings.push(`${where} dropped: the label is longer than ${EXTRA_MAX_LABEL} characters`);
    else if (String(r.value).length > EXTRA_MAX_VALUE) warnings.push(`${where} dropped: the value is longer than ${EXTRA_MAX_VALUE} characters`);
    else lines.push({ label: r.label, value: r.value as string | number });
  }
  if (data.length > EXTRA_MAX_ROWS) warnings.push(`returned ${data.length} rows; only the first ${EXTRA_MAX_ROWS} are kept`);
  return { lines: lines.slice(0, EXTRA_MAX_ROWS), warnings };
}

export async function runExtra(input: ExtraInput): Promise<ExtraResult> {
  const env = input.envText ? parseDotenv(input.envText) : {};
  if (env === null) return { error: "WEEKPOST_METRICS_EXTRA_ENV is not valid dotenv text (KEY=value per line)" };
  const timeoutMs = input.timeoutMs ?? EXTRA_TIMEOUT_MS;
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  try {
    const data = await Promise.race([Promise.resolve().then(() => input.hook({ from: input.from, to: input.to, accounts: [...input.accounts], env, signal: ctl.signal })), timeout]);
    return checkExtraRows(data);
  } catch (e) {
    // Only the error's name or message of a timeout is shown; the hook's own message may carry data, so it is not echoed.
    return { error: e instanceof Error && e.message.startsWith("timed out after") ? e.message : "the hook threw or rejected" };
  } finally {
    clearTimeout(timer);
  }
}
