// Cloudflare Worker adapter: a `scheduled` handler that turns env into `RunOptions`, builds the Supabase adapters
// over a counting `fetch`, and calls the pure `run`. No HTTP route: the Worker only answers its cron.
// Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
// Limits (50 subrequests per invocation on Free): https://developers.cloudflare.com/workers/platform/limits/#subrequests
import { supabaseDb } from "../src/queue/supabase.ts";
import { supabaseStorage } from "../src/queue/storage.ts";
import { GRAPH_API_VERSION, InstagramGraph } from "../src/publisher/instagram.ts";
import { DEFAULT_RUN_OPTIONS, resolveOptions, run, type RunOptions } from "../src/publisher/run.ts";

/** Secrets (`wrangler secret put`) and plain vars of the Worker. */
export interface WorkerEnv {
  WEEKPOST_SUPABASE_URL: string;
  /** Server-side secret key. Never put it in `wrangler.toml`. */
  WEEKPOST_SUPABASE_KEY: string;
  /** Private media bucket. Default "weekpost-media". */
  WEEKPOST_BUCKET?: string;
  /** Posts per run (1 to 10). Default 2: two carousels of 10 fit in the Free plan's 50 subrequests. */
  WEEKPOST_MAX_POSTS_PER_RUN?: string;
  /** Graph API version. Default: the one pinned in the package. */
  WEEKPOST_GRAPH_VERSION?: string;
  /** "false" turns token renewal off (test tokens, smoke runs). */
  WEEKPOST_REFRESH_TOKENS?: string;
  /** Days to keep media after publishing. Default 7. */
  WEEKPOST_PURGE_AFTER_DAYS?: string;
  /** Subrequests allowed per invocation. Default 50 (Free); raise it on a paid plan. */
  WEEKPOST_SUBREQUEST_BUDGET?: string;
}

const positive = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
};

export function optionsFromEnv(env: Partial<WorkerEnv>): RunOptions {
  return resolveOptions({
    maxPostsPerRun: positive(env.WEEKPOST_MAX_POSTS_PER_RUN, DEFAULT_RUN_OPTIONS.maxPostsPerRun),
    graphVersion: env.WEEKPOST_GRAPH_VERSION?.trim() || GRAPH_API_VERSION,
    refreshTokens: env.WEEKPOST_REFRESH_TOKENS?.trim().toLowerCase() !== "false",
    purgeAfterDays: positive(env.WEEKPOST_PURGE_AFTER_DAYS, DEFAULT_RUN_OPTIONS.purgeAfterDays),
    subrequestBudget: positive(env.WEEKPOST_SUBREQUEST_BUDGET, DEFAULT_RUN_OPTIONS.subrequestBudget),
  });
}

const logLine = (event: string, data: Record<string, unknown>) =>
  (event.startsWith("ERROR") ? console.error : console.log)(JSON.stringify({ event, ...data }));

/** Builds everything over a `fetch` that counts each call, then runs. `fetchFn` is injectable for tests. */
export async function runFromEnv(
  env: WorkerEnv,
  fetchFn: typeof fetch = (...a) => fetch(...a),
  log: (event: string, data: Record<string, unknown>) => void = logLine,
) {
  let calls = 0;
  const counted: typeof fetch = (...a) => (calls++, fetchFn(...a));
  const options = optionsFromEnv(env);
  return run(options, {
    db: supabaseDb(env.WEEKPOST_SUPABASE_URL, env.WEEKPOST_SUPABASE_KEY, counted),
    storage: supabaseStorage(env.WEEKPOST_SUPABASE_URL, env.WEEKPOST_SUPABASE_KEY, env.WEEKPOST_BUCKET || "weekpost-media", counted),
    graph: new InstagramGraph(counted, options.graphVersion),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    subrequests: () => calls,
  });
}

export default {
  async scheduled(_controller: { cron?: string }, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(runFromEnv(env).catch((e) => logLine("ERROR_run", { error: String((e as Error)?.message ?? e) })));
  },
};
