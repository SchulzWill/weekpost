// One publisher run: tokens -> refresh -> claim -> posts one at a time -> cleanup and stuck posts (in a separate `try`).
// Pure: no env, no clock, no global `fetch`. Everything comes in through `RunOptions` and `RunDeps`.
//
// Subrequest budget. Workers Free allows 50 subrequests per invocation, and "a subrequest is any request a Worker
// makes using the Fetch API or to Cloudflare services like R2, KV, or D1" (every Supabase call counts too).
// Source: https://developers.cloudflare.com/workers/platform/limits/#subrequests
//   fixed   tokens 1 + claim 1 + stuck 1 + cleanup <= 5 (select, delete, 3 marks); a renewal costs 2 per account (Meta + save)
//           and is counted for real (it happens before the claim), so it is not reserved here
//   a post  image 6 · Reel 4 to 7 · carousel of 10 on the slow path: sign 1 + children 10 + parent 1 + store 1
//           + up to 3 status checks + publish 1 + permalink 1 + record up to 2 (the first attempt may fail) = 20
//   Default of 2 posts: tokens 1 + claim 1 + maintenance 6 + 2 x 20 = 48, which leaves room for ONE renewal (2) = 50.
//   With two accounts renewing in the same run the room is 38 and `claim` is asked for 1 post. `claim` is asked
//   only for as many posts as the remaining budget covers at the worst case (20 each).
import type { PublisherDb, Storage, Token } from "../queue/types.ts";
import { GRAPH_API_VERSION, type InstagramGraph } from "./instagram.ts";
import { purgeOldMedia, PURGE_AFTER_DAYS } from "./cleanup.ts";
import { MAX_POLLS, processPost, type Outcome } from "./publish.ts";
import { refreshTokens } from "./tokens.ts";

export interface RunOptions {
  /** Posts claimed per run (1 to 10). */
  maxPostsPerRun: number;
  /** Graph API version. Read by whoever builds the `InstagramGraph` (the adapter); kept here so one object configures a run. */
  graphVersion: string;
  /** false: never call Meta to renew tokens (test tokens, smoke runs); close-to-expiry tokens are still reported. */
  refreshTokens: boolean;
  purgeAfterDays: number;
  signedUrlTtlSeconds: number;
  /** Subrequests allowed per invocation (50 on Workers Free). Only enforced when `deps.subrequests` is given. */
  subrequestBudget: number;
}

export interface RunDeps {
  db: PublisherDb;
  storage: Pick<Storage, "sign" | "remove">;
  graph: InstagramGraph;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(event: string, data: Record<string, unknown>): void;
  /** Subrequests made so far in this invocation. Without it the budget is not enforced. */
  subrequests?(): number;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  maxPostsPerRun: 2,
  graphVersion: GRAPH_API_VERSION,
  refreshTokens: true,
  purgeAfterDays: PURGE_AFTER_DAYS,
  signedUrlTtlSeconds: 3600,
  subrequestBudget: 50,
};

/** Worst case for one post (a carousel of 10 images): see the budget above. */
export const POST_SUBREQUESTS = 1 + 10 + 1 + 1 + MAX_POLLS + 1 + 1 + 2;
/** Reserved after the claim: stuck check 1 + cleanup up to 5. */
export const MAINTENANCE_SUBREQUESTS = 6;
/** The `claim` call itself. */
const CLAIM_SUBREQUESTS = 1;

const STUCK_AFTER_MS = 30 * 60_000;

export function resolveOptions(o: Partial<RunOptions> = {}): RunOptions {
  const merged = { ...DEFAULT_RUN_OPTIONS, ...o };
  const max = Math.min(Math.max(Math.trunc(Number(merged.maxPostsPerRun)) || DEFAULT_RUN_OPTIONS.maxPostsPerRun, 1), 10);
  return { ...merged, maxPostsPerRun: max };
}

export async function run(options: Partial<RunOptions>, d: RunDeps): Promise<{ claimed: number; outcomes: Outcome[] }> {
  const o = resolveOptions(options);
  const outcomes: Outcome[] = [];
  let claimed = 0;
  try {
    const tokens = new Map<string, Token>((await d.db.tokens()).map((t) => [t.account, t]));
    if (tokens.size === 0) d.log("ERROR_no_token", {});
    await refreshTokens(tokens, d.db, d.graph, d.now(), d.log, { refresh: o.refreshTokens });

    const limit = claimLimit(o, d);
    if (limit < o.maxPostsPerRun) {
      d.log("ERROR_budget", { wanted: o.maxPostsPerRun, claiming: limit, used: d.subrequests?.() ?? 0, budget: o.subrequestBudget });
    }
    const posts = limit > 0 ? await d.db.claim(limit) : [];
    claimed = posts.length;
    const deps = { db: d.db, storage: d.storage, graph: d.graph, sleep: d.sleep, log: d.log, signedUrlTtlSeconds: o.signedUrlTtlSeconds };
    // Different accounts in parallel gain nothing (the subrequest budget is the limit): one at a time.
    for (const post of posts) {
      try {
        outcomes.push(await processPost(post, tokens.get(post.account), deps));
      } catch (e) {
        // Not even markFailed reached the database: the post stays in `publishing` (safe) and the others go on.
        d.log("ERROR_post", { post: post.postId, account: post.account, error: String((e as Error).message) });
        outcomes.push("failed");
      }
    }

    try {
      await purgeOldMedia(d.db, d.storage, d.now(), d.log, o.purgeAfterDays);
      const stuck = await d.db.stuck(new Date(d.now() - STUCK_AFTER_MS).toISOString());
      if (stuck.length) d.log("ERROR_post_stuck_publishing", { posts: stuck });
    } catch (e) {
      d.log("ERROR_maintenance", { error: String((e as Error).message) });
    }
  } finally {
    if (d.subrequests) d.log("subrequests", { total: d.subrequests() });
  }
  return { claimed, outcomes };
}

/** How many posts the remaining budget covers at the worst case. Without a counter, the configured maximum. */
function claimLimit(o: RunOptions, d: RunDeps): number {
  if (!d.subrequests) return o.maxPostsPerRun;
  const room = o.subrequestBudget - d.subrequests() - CLAIM_SUBREQUESTS - MAINTENANCE_SUBREQUESTS;
  return Math.min(o.maxPostsPerRun, Math.max(Math.floor(room / POST_SUBREQUESTS), 0));
}
