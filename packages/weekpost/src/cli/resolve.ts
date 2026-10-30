// weekpost resolve <post-id> --account=<id> (--published=<permalink> | --not-published) [--yes]
// For a row stuck in `publishing` for over 30 minutes: after checking Instagram, record that it went out (with its
// link) or send it back to the queue.
import { planResolve, STUCK_AFTER_MINUTES, weekOfPostId, type Outcome } from "../queue/operate.ts";
import type { Out } from "./check.ts";
import { confirmChanges, connect, optionOf, positional, type OperateDeps } from "./queueCommon.ts";

const USAGE = "usage: weekpost resolve <post-id> --account=<id> (--published=<permalink> | --not-published) [--yes]";

export async function runResolve(args: string[], out: Out = console, cwd = process.cwd(), deps: OperateDeps = {}): Promise<number> {
  const [postId] = positional(args);
  const account = optionOf(args, "account");
  const permalink = optionOf(args, "published");
  const notPublished = args.includes("--not-published");
  if (!postId || !account || (permalink === undefined) === !notPublished) {
    out.error(USAGE);
    return 2;
  }
  const outcome: Outcome = notPublished ? { published: false } : { published: true, permalink: permalink! };
  const conn = await connect(args, out, cwd, deps);
  if (!conn) return 1;
  try {
    const [row] = (await conn.db.rows({ week: weekOfPostId(postId) })).filter((r) => r.postId === postId && r.account === account);
    if (!row) throw new Error(`no queued row for ${postId}/${account}`);
    const plan = planResolve(row, outcome, (deps.now ?? (() => new Date()))());
    if (!plan.ok) {
      out.error(plan.reason);
      return 1;
    }
    if (!(await confirmChanges(args, [plan], "Resolve", out, deps))) return 1;
    await conn.db.resolveStuck(plan.key, outcome);
    out.log(`resolved ${postId}/${account} (stuck for over ${STUCK_AFTER_MINUTES} min)`);
    return 0;
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
}
