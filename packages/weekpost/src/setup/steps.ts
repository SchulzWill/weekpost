// The steps of `weekpost setup`: stable ids, what the probe found, and the exact commands `--apply` runs.
// Nothing here writes anything. A command line shown to the user never carries a secret value: secrets travel on stdin.
import type { Fetch } from "../queue/types.ts";
import type { Runner } from "./runner.ts";

export type StepState = "ok" | "todo" | "needs-you" | "unknown";

export type StepId =
  | "prereq.logins"
  | "project.deps"
  | "db.migrate"
  | "storage.bucket"
  | "worker.deploy"
  | "worker.secrets"
  | "github.label"
  | "github.secrets"
  | "github.environment"
  | "local.secrets"
  | `token.${string}`;

export const ENVIRONMENT = "weekpost";
export const WORKER_SECRETS = ["WEEKPOST_SUPABASE_URL", "WEEKPOST_SUPABASE_KEY"] as const;
export const ACTIONS_SECRET = "OPENROUTER_API_KEY";
export const DEFAULT_BUCKET = "weekpost-media";

export type Account = { id: string; handle: string };

/** Everything a probe or an action may need. Every outside effect is an injected function. */
export type SetupContext = {
  projectRoot: string;
  /** Name of the project (the directory name); keys the local secrets file. */
  project: string;
  accounts: Account[];
  previewLabel: string;
  bucket: string;
  /** Highest migration number that ships with the package. */
  latestSchema: number;
  /** Where the local secrets file lives: ~/.config/weekpost/<folder>-<hash of the path>.env. */
  localEnvFile: string;
  supabase: { url?: string; key?: string };
  env: Record<string, string | undefined>;
  run: Runner;
  fetch: Fetch;
  /** Is the Playwright Chromium on this machine? */
  hasChromium: () => Promise<boolean>;
};

export type Probe = { state: StepState; detail: string };

export type Step = {
  id: StepId;
  title: string;
  /** The commands `--apply` runs for this step, as they are typed. Secret values are never in them. */
  commands: string[];
  /** Why this cannot be automated, for `needs-you` steps. */
  guide?: string;
};

const WORKER_DIR = "worker";
export const wranglerLine = (args: string) => `npx wrangler@4 ${args}   (in ${WORKER_DIR}/)`;

/** The steps in the order `--apply` goes through them. */
export function stepsFor(ctx: Pick<SetupContext, "accounts" | "previewLabel" | "bucket" | "project" | "latestSchema">): Step[] {
  const steps: Step[] = [
    { id: "prereq.logins", title: "Logins (GitHub and Cloudflare)", commands: ["gh auth status", "npx wrangler@4 whoami"], guide: "run `gh auth login` and `npx wrangler login` yourself" },
    { id: "project.deps", title: "Chromium for the renderer", commands: ["npx playwright install chromium"] },
    {
      id: "db.migrate",
      title: `Database schema (migrations up to ${ctx.latestSchema})`,
      commands: ["apply the pending migrations/000N_*.sql with pg, one transaction each (the connection string is typed at a hidden prompt)", "weekpost setup --apply --only=db.migrate --print   (prints the SQL instead, to paste in the editor)"],
    },
    { id: "storage.bucket", title: `Media bucket "${ctx.bucket}"`, commands: [`POST <supabase url>/storage/v1/bucket   (private bucket "${ctx.bucket}", 50 MiB, jpeg and mp4)`] },
    { id: "local.secrets", title: "Local secrets file", commands: [`write ~/.config/weekpost/${ctx.project}-<hash of the project path>.env   (mode 0600)`] },
    // Deploy first: `wrangler secret put` on a Worker that does not exist yet asks whether to create it.
    { id: "worker.deploy", title: "Worker deploy", commands: [wranglerLine("deploy")] },
    { id: "worker.secrets", title: "Worker secrets", commands: ["WEEKPOST_SUPABASE_URL", "WEEKPOST_SUPABASE_KEY"].map((n) => `${wranglerLine(`secret put ${n}`)}   (value on stdin)`) },
    { id: "github.label", title: `GitHub label "${ctx.previewLabel}"`, commands: [`gh label create ${JSON.stringify(ctx.previewLabel)}`] },
    { id: "github.secrets", title: "GitHub Actions secret", commands: [`gh secret set ${ACTIONS_SECRET}   (value on stdin)`] },
    {
      id: "github.environment",
      title: `GitHub environment "${ENVIRONMENT}"`,
      commands: [
        `gh api -X PUT repos/{owner}/{repo}/environments/${ENVIRONMENT}   (deployments only from main; other branch policies are listed and removed after a confirmation)`,
        ...WORKER_SECRETS.map((n) => `gh secret set ${n} --env ${ENVIRONMENT}   (value on stdin)`),
      ],
    },
  ];
  for (const a of ctx.accounts) {
    steps.push({
      id: `token.${a.id}`,
      title: `Instagram token for @${a.handle}`,
      commands: [`npx weekpost token ${a.id}`],
      guide: `generate a long-lived token in the Meta app panel, copy it, then run: npx weekpost token ${a.id}`,
    });
  }
  return steps;
}
