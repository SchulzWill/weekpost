// `weekpost agent-env`: checks that the environment an agent session runs in carries no infrastructure secret.
// Prints variable NAMES only, never values.
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { projectPaths, type Out } from "./check.ts";
import { legacyLocalEnvPath, localEnvPath } from "./secrets.ts";

const FORBIDDEN = [/^WEEKPOST_SUPABASE_/, /^CLOUDFLARE_/, /^DATABASE_URL$/];

/** Names of the infrastructure secrets present (non-empty) in the environment. */
export function forbiddenVars(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => env[k] && FORBIDDEN.some((re) => re.test(k))).sort();
}

/** True when the project's local secrets file exists and this process can read it. */
export function localSecretsReadable(projectRoot: string, home: string = homedir()): boolean {
  const candidates = [localEnvPath(projectRoot, home), legacyLocalEnvPath(projectRoot, home)];
  return candidates.some((path) => {
    if (!path) return false;
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function runAgentEnv(
  args: string[],
  out: Out = console,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  projectRoot: string = projectPaths(args, process.cwd()).projectRoot,
): number {
  const found = forbiddenVars(env);
  const file = localSecretsReadable(projectRoot, home);
  if (found.length === 0 && !file) {
    out.log("agent environment is clean: no infrastructure secrets in the environment, and the local secrets file is not readable by this user");
    return 0;
  }
  if (found.length) out.error(`this environment has infrastructure secrets an agent must not see: ${found.join(", ")}`);
  if (file) {
    out.error("the local secrets file (~/.config/weekpost/) exists and this user can read it, so an agent running as this user can read it too");
    out.error("run the agent in a sandbox that denies reading ~/.config/weekpost/, or as another system user without access to it");
  }
  out.error("open a clean session before letting an agent read sources or open the week");
  return 1;
}
