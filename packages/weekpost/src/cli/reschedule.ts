// weekpost reschedule <post-id> --account=<id> --at="YYYY-MM-DD HH:MM" [--rearm] [--yes]
// Moves a scheduled row (or a failed one, with --rearm, which also resets its attempts). --at is local time of the
// account. The time then wins over later enqueues until the post content changes.
import { parseLocalTime, planReschedule, weekOfPostId } from "../queue/operate.ts";
import type { Out } from "./check.ts";
import { confirmChanges, connect, optionOf, positional, type OperateDeps } from "./queueCommon.ts";

const USAGE = 'usage: weekpost reschedule <post-id> --account=<id> --at="YYYY-MM-DD HH:MM" [--rearm] [--yes]';

export async function runReschedule(args: string[], out: Out = console, cwd = process.cwd(), deps: OperateDeps = {}): Promise<number> {
  const [postId] = positional(args);
  const account = optionOf(args, "account");
  const at = optionOf(args, "at");
  if (!postId || !account || !at) {
    out.error(USAGE);
    return 2;
  }
  const conn = await connect(args, out, cwd, deps);
  if (!conn) return 1;
  try {
    const zone = conn.zones[account];
    if (!zone) throw new Error(`account "${account}" is not in the config (accounts: ${Object.keys(conn.zones).join(", ")})`);
    const publishAt = parseLocalTime(at, zone);
    const [row] = (await conn.db.rows({ week: weekOfPostId(postId) })).filter((r) => r.postId === postId && r.account === account);
    if (!row) throw new Error(`no queued row for ${postId}/${account}`);
    const rearm = args.includes("--rearm");
    const plan = planReschedule(row, publishAt, { rearm, zone, now: (deps.now ?? (() => new Date()))() });
    if (!plan.ok) {
      out.error(plan.reason);
      return 1;
    }
    if (!(await confirmChanges(args, [plan], "Reschedule", out, deps))) return 1;
    await conn.db.reschedule(plan.key, publishAt, { rearm });
    out.log(`rescheduled ${postId}/${account}`);
    return 0;
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
}
