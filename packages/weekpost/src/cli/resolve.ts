// weekpost resolve <post-id> --account=<id> (--published[=<permalink>] | --not-published) [--yes]
// Two cases. A row stuck in `publishing` for over 30 minutes: after checking Instagram, record that it went out (with
// its link) or send it back to the queue. A manual Story: record that you posted it by hand, or cancel it.
import { planResolve, STUCK_AFTER_MINUTES, weekOfPostId, type ResolveAction } from "../queue/operate.ts";
import type { Out } from "./check.ts";
import { confirmChanges, connect, optionOf, positional, type OperateDeps } from "./queueCommon.ts";

const USAGE = [
  "usage: weekpost resolve <post-id> --account=<id> (--published[=<permalink>] | --not-published) [--yes]",
  "  stuck in publishing: --published=<permalink> (link required) or --not-published (queue it again)",
  "  manual Story: --published[=<permalink>] (you posted it) or --not-published (cancel it; weekpost restore undoes this)",
].join("\n");

export async function runResolve(args: string[], out: Out = console, cwd = process.cwd(), deps: OperateDeps = {}): Promise<number> {
  const [postId] = positional(args);
  const account = optionOf(args, "account");
  const permalink = optionOf(args, "published");
  const published = args.includes("--published") || permalink !== undefined;
  const notPublished = args.includes("--not-published");
  if (!postId || !account || published === notPublished || (permalink === "")) {
    out.error(USAGE);
    return 2;
  }
  const action: ResolveAction = notPublished ? { published: false } : permalink ? { published: true, permalink } : { published: true };
  const conn = await connect(args, out, cwd, deps);
  if (!conn) return 1;
  try {
    const [row] = (await conn.db.rows({ week: weekOfPostId(postId) })).filter((r) => r.postId === postId && r.account === account);
    if (!row) throw new Error(`no queued row for ${postId}/${account}`);
    const plan = planResolve(row, action, (deps.now ?? (() => new Date()))());
    if (!plan.ok) {
      out.error(plan.reason);
      return 1;
    }
    if (!(await confirmChanges(args, [plan], "Resolve", out, deps))) return 1;
    if (row.status === "publishing") {
      await conn.db.resolveStuck(plan.key, action as { published: true; permalink: string } | { published: false });
      out.log(`resolved ${postId}/${account} (stuck for over ${STUCK_AFTER_MINUTES} min)`);
    } else {
      await conn.db.resolveManual(plan.key, action);
      out.log(`${postId}/${account}: ${action.published ? "recorded as published" : "canceled"}`);
    }
    return 0;
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
}
