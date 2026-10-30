// Subcommand dispatcher behind bin/weekpost.js.
import { runCheck } from "./check.ts";
import { runInit } from "./init.ts";
import { runCi } from "./ci.ts";
import { runEnqueue } from "./enqueue.ts";
import { runGenerate } from "./generate.ts";
import { runPackage } from "./package.ts";
import { runPreview } from "./preview.ts";
import { runWeeks } from "./weeks.ts";
import { runCancel } from "./cancel.ts";
import { runReschedule } from "./reschedule.ts";
import { runResolve } from "./resolve.ts";
import { runRestore } from "./restore.ts";
import { runStatus } from "./status.ts";
import { runAgentEnv } from "./agentEnv.ts";
import { runToken } from "./token.ts";
import { runSources } from "./sources.ts";
import { runFirstPost } from "./firstPost.ts";
import { runSetup } from "./setup.ts";
import { runDoctor } from "./doctor.ts";
import { runMetrics } from "./metrics.ts";
import { readFileSync } from "node:fs";

// The version of the installed package, read from its package.json.
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

const USAGE = `usage: weekpost <command> [options]

commands:
  init [dir]            copy the template into a project and fill in the config (--answers=<file.json> without a terminal)
  check [YYYY-Www]      validate and lint the content (--root=content, --project=<dir>)
  generate <YYYY-Www>   render a week into out/ (--root=content, --project=<dir>, --post=<id>, --fake-media)
  package <YYYY-Www>    copy the media, caption, time and link of a generated week into one folder per post (--from=<out-dir>, --dest=<dir>, --post=<id>)
  enqueue <artifact-dir>  put the approved week into the queue (--weeks=<file>, --root=content, --dry-run, --allow-past, --commit=<sha>, --summary=<file>)
  weeks <paths-file>    list the content weeks touched by a list of changed files (optional second argument: output file)
  preview <pr>          download the preview of a pull request with gh and open it (--repo=<owner/name>, --dest=<dir>, --no-open)
  ci <pack|comment>     helpers for the CI workflows (pack the preview artifact, write the pull request comments)
  status                list the queue (--week=YYYY-Www, --failed, --json)
  cancel <post-id>      cancel a post that has not gone out (--account=<id>, --yes)
  restore <post-id>     undo a cancel (--account=<id>, --allow-past, --yes)
  reschedule <post-id>  move a scheduled post (--account=<id>, --at="YYYY-MM-DD HH:MM", --rearm, --yes)
  resolve <post-id>     settle a post stuck in publishing (--account=<id>, --published=<link> | --not-published, --yes)
  token <account>       save the Instagram token of an account (--prompt to type it instead of reading the clipboard; needs a terminal)
  sources pull <YYYY-Www>  write content/<week>/sources.json from the configured sources (the week before; --limit=20, --root=content, --project=<dir>)
  setup --plan|--apply  list the setup steps and what is done (--plan, --json), or run them at a terminal after asking (--apply, --only=<step-id>)
  doctor                check, without writing anything, that the setup works and say what to run for each failure (--json)
  metrics               read Instagram Insights and print the weekly report (--write to store it, --issue to post it as an issue, --json)
  first-post <account>  publish one public test post through your own Worker and wait for the permalink (--caption=<text>, --yes, --timeout=15 minutes)
  --version             print the installed version
  agent-env             exit 1 if this environment holds infrastructure secrets (names only are printed)

The queue commands read WEEKPOST_SUPABASE_URL and WEEKPOST_SUPABASE_KEY.`;

// Returns the exit code.
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return runInit(rest);
    case "check":
      return runCheck(rest);
    case "generate":
      return runGenerate(rest);
    case "package":
      return runPackage(rest);
    case "enqueue":
      return runEnqueue(rest);
    case "weeks":
      return runWeeks(rest);
    case "preview":
      return runPreview(rest);
    case "ci":
      return runCi(rest);
    case "status":
      return runStatus(rest);
    case "cancel":
      return runCancel(rest);
    case "restore":
      return runRestore(rest);
    case "reschedule":
      return runReschedule(rest);
    case "resolve":
      return runResolve(rest);
    case "token":
      return runToken(rest);
    case "sources":
      return runSources(rest);
    case "metrics":
      return runMetrics(rest);
    case "first-post":
      return runFirstPost(rest);
    case "setup":
      return runSetup(rest);
    case "doctor":
      return runDoctor(rest);
    case "agent-env":
      return runAgentEnv(rest);
    case "--version":
    case "-v":
      console.log(packageVersion());
      return 0;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return command === undefined ? 2 : 0;
    default:
      console.error(`weekpost: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}
