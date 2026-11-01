// weekpost metrics [--write] [--issue] [--json] [--repo=<owner/name>] [--project=<dir>]
// Reads Instagram Insights for the posts of the last two weeks and for each account, builds the weekly report and prints
// it. `--write` stores the numbers in weekpost_metrics; `--issue` rewrites (or creates) the issue "weekpost metrics:
// <YYYY-Www>". Both change something outside the repository, so both are denied to the agent and meant for CI.
// Missing data is not a failure: it becomes a line under Attention and the exit code stays 0. Only a failure of the
// run itself (no database, GitHub refusing the issue) exits 1. Tokens, keys and Meta's raw answers are never printed.
import { GRAPH_API_VERSION, InstagramGraph } from "../publisher/instagram.ts";
import { supabaseDb } from "../queue/supabase.ts";
import type { Fetch, MetricsDb } from "../queue/types.ts";
import { graphVersionStatus } from "../setup/graphVersions.ts";
import { collectMetrics } from "../metrics/collect.ts";
import { loadConfig } from "../config/load.ts";
import type { WeekpostConfig } from "../config/schema.ts";
import { runExtra } from "../metrics/extra.ts";
import { GithubIssues } from "../metrics/github.ts";
import { attentionLines, buildReport, ISSUE_LABEL, issueTitle, OVERDUE_MINUTES, STUCK_MINUTES, type ReportInput } from "../metrics/report.ts";
import { projectPaths, type Out } from "./check.ts";
import { optionOf } from "./queueCommon.ts";
import { hasTty, withLocalEnv } from "./secrets.ts";

export type MetricsDeps = {
  db?: MetricsDb;
  fetch?: Fetch;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  home?: string;
  tty?: boolean;
  /** Skips reading weekpost.config.ts (tests). */
  config?: Pick<WeekpostConfig, "metrics">;
};

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Monday 00:00 UTC of the week of `d`, and the next Monday: the window of "Stories this week". */
function weekBounds(d: Date): [string, string] {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() || 7) - 1));
  return [start.toISOString(), new Date(start.getTime() + 7 * DAY).toISOString()];
}

/** Runs the optional hook. Off (`extra: null`) without `metrics.extra`; any failure comes back as `extraError`, never as a throw. */
async function extraNumbers(preset: MetricsDeps["config"], projectRoot: string, env: Record<string, string | undefined>, now: Date, accounts: string[]): Promise<Pick<ReportInput, "extra" | "extraError" | "extraWarnings">> {
  let config = preset;
  if (!config) {
    try {
      config = (await loadConfig(projectRoot)).config;
    } catch (e) {
      // No config file: the hook is simply off. A broken one is worth a line, since the hook may be what it breaks.
      return /not found/.test((e as Error).message) ? { extra: null } : { extra: null, extraError: "weekpost.config.ts could not be loaded, so the hook did not run (run `npx weekpost check`)" };
    }
  }
  const hook = config.metrics?.extra;
  if (!hook) return { extra: null };
  const r = await runExtra({ hook, envText: env.WEEKPOST_METRICS_EXTRA_ENV, from: new Date(now.getTime() - 7 * DAY).toISOString(), to: now.toISOString(), accounts });
  return "lines" in r ? { extra: r.lines, extraWarnings: r.warnings } : { extra: [], extraError: r.error };
}

export async function runMetrics(args: string[], out: Out = console, cwd = process.cwd(), deps: MetricsDeps = {}): Promise<number> {
  const unknown = args.filter((a) => !["--write", "--issue", "--json"].includes(a) && !a.startsWith("--repo=") && !a.startsWith("--project="));
  if (unknown.length) {
    out.error(`unknown argument: ${unknown[0]}\nusage: weekpost metrics [--write] [--issue] [--json] [--repo=<owner/name>]`);
    return 2;
  }
  const write = args.includes("--write");
  const issue = args.includes("--issue");
  const json = args.includes("--json");
  const now = (deps.now ?? (() => new Date()))();
  const tty = deps.tty ?? hasTty();
  const env = withLocalEnv(deps.env ?? process.env, projectPaths(args, cwd).projectRoot, deps.home, write ? { tty } : undefined);
  const fetchFn = deps.fetch ?? fetch;

  try {
    const db = deps.db ?? supabaseDb(env.WEEKPOST_SUPABASE_URL ?? "", env.WEEKPOST_SUPABASE_KEY ?? "", fetchFn);
    const collected = await collectMetrics({ db, graph: new InstagramGraph(fetchFn), now });
    const [weekStart, weekEnd] = weekBounds(now);
    const { extra, extraError, extraWarnings } = await extraNumbers(deps.config, projectPaths(args, cwd).projectRoot, env, now, collected.accounts);
    const input: ReportInput = {
      now,
      collected,
      failed: await db.failed(),
      stuck: await db.stuck(new Date(now.getTime() - STUCK_MINUTES * MINUTE).toISOString()),
      overdue: await db.overdue(new Date(now.getTime() - OVERDUE_MINUTES * MINUTE).toISOString()),
      manual: await db.manualDue(weekStart, weekEnd),
      tokens: (await db.tokens()).map((t) => ({ account: t.account, expiresAt: t.expiresAt })),
      graph: { version: GRAPH_API_VERSION, ...graphVersionStatus(GRAPH_API_VERSION, now) },
      extra,
      ...(extraError ? { extraError } : {}),
      ...(extraWarnings?.length ? { extraWarnings } : {}),
    };
    const markdown = buildReport(input);

    if (write) await db.upsertMetrics(collected.rows);

    let issueResult: { action: string; number: number; url: string } | undefined;
    if (issue) {
      const repo = optionOf(args, "repo") ?? env.GITHUB_REPOSITORY ?? "";
      issueResult = await new GithubIssues(fetchFn, repo, env.GITHUB_TOKEN ?? "").upsert(issueTitle(now), markdown, ISSUE_LABEL);
    }

    if (json) {
      out.log(JSON.stringify({
        title: issueTitle(now), written: write ? collected.rows.length : 0, rows: collected.rows, attention: attentionLines(input),
        issues: collected.issues, issue: issueResult ?? null, markdown,
      }, null, 2));
    } else {
      out.log(markdown);
      out.error(write ? `wrote ${collected.rows.length} metric(s)` : "dry run: nothing written (pass --write to store the numbers)");
      if (issueResult) out.error(`issue ${issueResult.action}: ${issueResult.url || `#${issueResult.number}`}`);
    }
    return 0;
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
}
