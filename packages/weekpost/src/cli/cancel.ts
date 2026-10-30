// weekpost cancel <post-id> [--account=<id>] [--yes]
// Cancels the scheduled, manual or failed rows of a post (all its accounts, or only --account).
// A row that is publishing or published is refused, with the reason.
import { planCancel, weekOfPostId } from "../queue/operate.ts";
import type { Out } from "./check.ts";
import { confirmChanges, connect, optionOf, positional, type OperateDeps } from "./queueCommon.ts";

export async function runCancel(args: string[], out: Out = console, cwd = process.cwd(), deps: OperateDeps = {}): Promise<number> {
  const [postId] = positional(args);
  if (!postId) {
    out.error("usage: weekpost cancel <post-id> [--account=<id>] [--yes]");
    return 2;
  }
  const account = optionOf(args, "account");
  const conn = await connect(args, out, cwd, deps);
  if (!conn) return 1;
  try {
    const rows = (await conn.db.rows({ week: weekOfPostId(postId) })).filter((r) => r.postId === postId && (!account || r.account === account));
    if (!rows.length) {
      out.error(`no queued row for ${postId}${account ? `/${account}` : ""}`);
      return 1;
    }
    const plans = rows.map(planCancel);
    for (const p of plans) if (!p.ok) out.error(p.reason);
    const ok = plans.flatMap((p) => (p.ok ? [p] : []));
    if (!ok.length) return 1;
    if (!(await confirmChanges(args, ok, "Cancel", out, deps))) return 1;
    for (const p of ok) {
      const previous = await conn.db.cancel(p.key, "operator");
      out.log(`canceled ${p.key.postId}/${p.key.account} (was ${previous})`);
    }
    return plans.length === ok.length ? 0 : 1;
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
}
