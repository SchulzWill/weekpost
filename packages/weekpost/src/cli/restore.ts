// weekpost restore <post-id> [--account=<id>] [--allow-past] [--yes]
// Undoes a cancel: the canceled rows of a post (all its accounts, or only --account) go back to scheduled (a Story, to
// manual). A time already past is refused unless --allow-past, because the post would go out at once.
import { planRestore, weekOfPostId } from "../queue/operate.ts";
import type { Out } from "./check.ts";
import { confirmChanges, connect, optionOf, positional, type OperateDeps } from "./queueCommon.ts";

export async function runRestore(args: string[], out: Out = console, cwd = process.cwd(), deps: OperateDeps = {}): Promise<number> {
  const [postId] = positional(args);
  if (!postId) {
    out.error("usage: weekpost restore <post-id> [--account=<id>] [--allow-past] [--yes]");
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
    const now = (deps.now ?? (() => new Date()))();
    const plans = rows.map((r) => planRestore(r, { zone: conn.zones[r.account], now, allowPast: args.includes("--allow-past") }));
    for (const p of plans) if (!p.ok) out.error(p.reason);
    const ok = plans.flatMap((p) => (p.ok ? [p] : []));
    if (!ok.length) return 1;
    if (!(await confirmChanges(args, ok, "Restore", out, deps))) return 1;
    for (const p of ok) {
      await conn.db.restore(p.key);
      out.log(`restored ${p.key.postId}/${p.key.account}`);
    }
    return plans.length === ok.length ? 0 : 1;
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
}
