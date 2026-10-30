// weekpost status [--week=YYYY-Www] [--failed] [--json] [--project=<dir>]
// Lists the queue with the local time and zone of each account. Without --week it shows the rows that are not
// finished yet (scheduled, manual, publishing, failed); --failed shows only the failed ones.
import { statusJson, statusLine } from "../queue/operate.ts";
import type { Status } from "../queue/types.ts";
import type { Out } from "./check.ts";
import { connect, optionOf, type OperateDeps } from "./queueCommon.ts";

const OPEN: Status[] = ["scheduled", "manual", "publishing", "failed"];

export async function runStatus(args: string[], out: Out = console, cwd = process.cwd(), deps: OperateDeps = {}): Promise<number> {
  const week = optionOf(args, "week");
  if (week && !/^\d{4}-W\d{2}$/.test(week)) {
    out.error("usage: weekpost status [--week=YYYY-Www] [--failed] [--json]");
    return 2;
  }
  const conn = await connect(args, out, cwd, deps, false);
  if (!conn) return 1;
  let rows;
  try {
    rows = await conn.db.rows({ week, status: args.includes("--failed") ? ["failed"] : week ? undefined : OPEN });
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
  if (args.includes("--json")) {
    out.log(JSON.stringify(rows.map((r) => statusJson(r, conn.zones)), null, 2));
    return 0;
  }
  for (const r of rows) out.log(statusLine(r, conn.zones));
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  out.log(rows.length ? `${rows.length} row(s): ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ")}` : "no rows");
  return 0;
}
