// weekpost stories --remind [--issue] [--json] [--repo=<owner/name>] [--project=<dir>]
// weekpost does not post Stories: you post each one by hand, with the link sticker. This command reminds you. It lists the
// manual Stories whose time falls in the next hour and prints what to do for each. `--issue` also opens one GitHub issue
// per Story (label `story`, one per post and account) and closes the issue of a Story you have since settled (published
// or canceled). It writes to GitHub, so it is denied to the agent and meant for CI. Without `--issue` it only prints.
// An issue stays open while the row is `publishing`, `failed`, or `scheduled` as a manual Story: that is for you to decide.
import { GithubIssues, STORY_LABEL } from "../metrics/github.ts";
import { formatLocal, weekOfPostId } from "../queue/operate.ts";
import type { Fetch, OperatorDb, QueueRow } from "../queue/types.ts";
import { projectPaths, type Out } from "./check.ts";
import { connect, optionOf, type OperateDeps } from "./queueCommon.ts";
import { hasTty, withLocalEnv } from "./secrets.ts";

const HOUR = 3_600_000;

export type StoriesDeps = OperateDeps & { fetch?: Fetch };

const USAGE = "usage: weekpost stories --remind [--issue] [--json] [--repo=<owner/name>]";

/** The stable title: one issue per post and account. */
export const storyIssueTitle = (r: { postId: string; account: string }) => `weekpost story: ${r.postId}/${r.account}`;
const TITLE = /^weekpost story: (\S+)\/([^/\s]+)$/;

export function storyIssueBody(r: QueueRow, zone: string | undefined): string {
  const at = `${formatLocal(r.publishAt, zone)} ${zone ?? "UTC"}`;
  const key = `${r.postId} --account=${r.account}`;
  return [
    `Post this Story by hand at **${at}**. weekpost does not post Stories.`,
    "",
    `- Post: \`${r.postId}\` (account \`${r.account}\`)`,
    `- Link to put on the link sticker: ${r.link ?? "none"}`,
    "",
    "1. Get the files and the caption:",
    `   \`npx weekpost package ${r.week} --post=${r.postId}\``,
    "2. After you post it, record it (the link of the Story is optional):",
    `   \`npx weekpost resolve ${key} --published[=<link>]\``,
    "3. If you will not post it:",
    `   \`npx weekpost resolve ${key} --not-published\``,
    "",
    "This issue closes by itself, on the next hourly run, once the Story is recorded as published or canceled.",
  ].join("\n");
}

export async function runStories(args: string[], out: Out = console, cwd = process.cwd(), deps: StoriesDeps = {}): Promise<number> {
  const unknown = args.filter((a) => !["--remind", "--issue", "--json"].includes(a) && !a.startsWith("--repo=") && !a.startsWith("--project="));
  if (unknown.length || !args.includes("--remind")) {
    out.error(`${unknown.length ? `unknown argument: ${unknown[0]}\n` : ""}${USAGE}`);
    return 2;
  }
  const issue = args.includes("--issue");
  const json = args.includes("--json");
  const now = (deps.now ?? (() => new Date()))();
  const env = withLocalEnv(deps.env ?? process.env, projectPaths(args, cwd).projectRoot, deps.home, issue ? { tty: deps.tty ?? hasTty() } : undefined);
  const conn = await connect(args, out, cwd, { ...deps, env }, false);
  if (!conn) return 1;
  const { db, zones } = conn;

  try {
    const until = new Date(now.getTime() + HOUR).toISOString();
    const due = (await db.rows({ status: ["manual"] })).filter((r) => r.publishAt >= now.toISOString() && r.publishAt < until);
    const reminders: { postId: string; account: string; publishAt: string; local: string; issue: string; url?: string }[] = [];
    const closed: { number: number; title: string; status: string }[] = [];

    const gh = issue ? new GithubIssues(deps.fetch ?? fetch, optionOf(args, "repo") ?? env.GITHUB_REPOSITORY ?? "", env.GITHUB_TOKEN ?? "") : undefined;
    const existing = gh ? await gh.list(STORY_LABEL, "all") : [];

    for (const r of due) {
      const title = storyIssueTitle(r);
      const entry = { postId: r.postId, account: r.account, publishAt: r.publishAt, local: `${formatLocal(r.publishAt, zones[r.account])} ${zones[r.account] ?? "UTC"}`, issue: "not requested" };
      if (gh) {
        const found = existing.find((i) => i.title === title);
        if (found) Object.assign(entry, { issue: "exists", url: found.url });
        else {
          const made = await gh.create(title, storyIssueBody(r, zones[r.account]), STORY_LABEL);
          existing.push({ number: made.number, title, state: "open", url: made.url });
          Object.assign(entry, { issue: "created", url: made.url });
        }
      }
      reminders.push(entry);
    }

    if (gh) await closeSettled(gh, db, existing.filter((i) => i.state === "open"), closed);

    if (json) out.log(JSON.stringify({ until, reminders, closed }, null, 2));
    else {
      if (!reminders.length) out.log("no manual Story in the next hour");
      for (const r of reminders) out.log(`${r.local}  ${r.postId}/${r.account}: post it by hand${r.issue === "not requested" ? "" : ` (issue ${r.issue}${r.url ? `: ${r.url}` : ""})`}`);
      for (const c of closed) out.log(`closed #${c.number}: ${c.title} (${c.status})`);
      if (!issue && reminders.length) out.error("nothing written: pass --issue (in CI) to open the issues");
    }
    return 0;
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

/** Closes the open issues whose Story reached `published` or `canceled`. Any other status (publishing, failed, scheduled, manual) leaves it open. */
async function closeSettled(gh: GithubIssues, db: OperatorDb, open: { number: number; title: string }[], closed: { number: number; title: string; status: string }[]): Promise<void> {
  const byWeek = new Map<string, QueueRow[]>();
  for (const i of open) {
    const m = TITLE.exec(i.title);
    if (!m) continue;
    let week: string;
    try {
      week = weekOfPostId(m[1]!);
    } catch {
      continue;
    }
    if (!byWeek.has(week)) byWeek.set(week, await db.rows({ week }));
    const row = byWeek.get(week)!.find((r) => r.postId === m[1] && r.account === m[2]);
    if (row?.status !== "published" && row?.status !== "canceled") continue;
    await gh.close(i.number, row.status === "published" ? "Recorded as published." : "Recorded as canceled: the Story will not be posted.");
    closed.push({ number: i.number, title: i.title, status: row.status });
  }
}
