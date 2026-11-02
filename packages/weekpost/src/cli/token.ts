// weekpost token <account> [--prompt] [--login=instagram|unified] [--project=<dir>]
// Reads an Instagram token from the clipboard (or a hidden prompt), finds out which API it belongs to (Instagram
// Login on graph.instagram.com, or Unified login on graph.facebook.com), checks that it belongs to the account named
// in the config and may publish, then saves it in `weekpost_tokens` with its login mode and clears the clipboard.
// Needs a terminal. The token is never printed: not on success, not in any error.
// Unified login: `/me` is the business integration system user, so the account comes from
// `/me/assigned_instagram_accounts`: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-unified-login/get-started
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/load.ts";
import { ConfigError } from "../config/parse.ts";
import type { WeekpostConfig } from "../config/schema.ts";
import { insightsAccess, noInsightsMessage } from "../metrics/access.ts";
import { createInterface } from "node:readline/promises";
import { GRAPH_API_VERSION, GraphError, InstagramGraph, redact } from "../publisher/instagram.ts";
import { supabaseDb } from "../queue/supabase.ts";
import type { LoginMode, OperatorDb } from "../queue/types.ts";
import { schemaVersion } from "../setup/probes.ts";
import { projectPaths, type Out } from "./check.ts";
import { positional } from "./queueCommon.ts";
import { readSecret, requireTty, SecretError, withLocalEnv } from "./secrets.ts";

/** The token of the Instagram panel lasts 60 days; we record 59 so a refresh is never late. */
export const TOKEN_DAYS = 59;

/** Migration 0006 lets a token row say its login mode and have no expiry. */
export const UNIFIED_MIN_SCHEMA = 6;

export const LOGIN_LABEL: Record<LoginMode, string> = { instagram: "Instagram Login", unified: "Unified login" };
const PUBLISH_PERMISSION: Record<LoginMode, string> = { instagram: "instagram_business_content_publish", unified: "instagram_content_publish" };
const USAGE = "usage: weekpost token <account> [--prompt] [--login=instagram|unified]";

export interface Clipboard {
  /** The text on the clipboard, or null when it cannot be read. */
  read(): Promise<string | null>;
  clear(): Promise<void>;
}

export type TokenDeps = {
  config?: WeekpostConfig;
  db?: Pick<OperatorDb, "upsertToken">;
  fetch?: typeof fetch;
  tty?: boolean;
  clipboard?: Clipboard;
  /** Hidden prompt. */
  ask?: (label: string) => Promise<string>;
  /** Visible one-line prompt (the expiry of a Unified login token). */
  choose?: (question: string) => Promise<string>;
  /** Database schema version; null when it cannot be read. Default: read from Supabase. */
  schemaVersion?: () => Promise<number | null>;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** Home directory the local secrets file is read from. Default: the real one; tests pass a temporary one. */
  home?: string;
};

const COMMANDS: Record<string, { read: string[]; clear: string[] }> = {
  darwin: { read: ["pbpaste"], clear: ["pbcopy"] },
  win32: { read: ["powershell", "-NoProfile", "-Command", "Get-Clipboard"], clear: ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $null"] },
};
const LINUX_WAYLAND = { read: ["wl-paste", "--no-newline"], clear: ["wl-copy", "--clear"] };
const LINUX_X11 = { read: ["xclip", "-selection", "clipboard", "-o"], clear: ["xclip", "-selection", "clipboard", "-i"] };

function run(cmd: string[], input?: string): string | null {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { input: input ?? "", encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout : null;
}

export const systemClipboard: Clipboard = {
  async read() {
    const set = COMMANDS[process.platform];
    for (const c of set ? [set] : [LINUX_WAYLAND, LINUX_X11]) {
      const text = run(c.read);
      if (text !== null) return text;
    }
    return null;
  },
  async clear() {
    const set = COMMANDS[process.platform];
    for (const c of set ? [set] : [LINUX_WAYLAND, LINUX_X11]) if (run(c.clear, "") !== null) return;
    throw new Error("could not clear the clipboard");
  },
};

/** Instagram tokens are one long run of URL-safe characters. Anything else is not one. */
const looksLikeToken = (v: string) => /^[A-Za-z0-9_.-]{21,1024}$/.test(v);

// Returns the exit code.
export async function runToken(args: string[], out: Out = console, cwd = process.cwd(), deps: TokenDeps = {}): Promise<number> {
  const [accountId] = positional(args);
  const loginArg = args.find((a) => a.startsWith("--login="))?.slice("--login=".length);
  if (!accountId || (loginArg !== undefined && loginArg !== "instagram" && loginArg !== "unified")) {
    out.error(USAGE);
    return 2;
  }
  const forced = loginArg as LoginMode | undefined;
  const blocked = requireTty("token", out, deps.tty);
  if (blocked) return blocked;

  const { projectRoot } = projectPaths(args, cwd);
  let config = deps.config;
  if (!config) {
    try {
      config = (await loadConfig(projectRoot)).config;
    } catch (e) {
      out.error(e instanceof ConfigError ? e.message : `error: ${(e as Error).message}`);
      return 1;
    }
  }
  const account = config.accounts[accountId];
  if (!account) {
    out.error(`unknown account "${accountId}"; the config has: ${Object.keys(config.accounts).join(", ")}`);
    return 1;
  }

  // Read the token. From here on `token` must never reach a message unredacted.
  let token = "";
  let fromClipboard = false;
  const clipboard = deps.clipboard ?? systemClipboard;
  try {
    if (!args.includes("--prompt")) {
      const clip = (await clipboard.read())?.trim() ?? "";
      if (looksLikeToken(clip)) {
        token = clip;
        fromClipboard = true;
      } else {
        out.log("the clipboard does not hold a token; paste it at the prompt instead");
      }
    }
    if (!token) {
      token = (await readPrompt(deps)).trim();
      if (!looksLikeToken(token)) {
        out.error("that is not an Instagram access token (expected one long string without spaces); nothing was saved");
        return 1;
      }
    }
  } catch (e) {
    out.error(e instanceof SecretError ? e.message : "could not read the token");
    return 1;
  }
  const env = (() => {
    let cached: Record<string, string | undefined> | undefined;
    return () => (cached ??= withLocalEnv(deps.env ?? process.env, projectRoot, deps.home, { tty: true }));
  })();
  const dbKey = (deps.env ?? process.env).WEEKPOST_SUPABASE_KEY ?? "";
  // Defense in depth: the adapters already scrub their messages; this scrubs the token and the service key again.
  const safe = (e: unknown) => redact(redact(String((e as Error)?.message ?? e), token), dbKey);

  // Which API the token belongs to. The prefix only picks the order of the attempts, never the answer.
  const order: LoginMode[] = forced ? [forced] : token.startsWith("EAA") ? ["unified", "instagram"] : ["instagram", "unified"];
  const fetchFn = deps.fetch ?? fetch;
  let found: { login: LoginMode; graph: InstagramGraph; userId: string; username: string } | undefined;
  const failures: { login: LoginMode; error: unknown }[] = [];
  for (const login of order) {
    const graph = new InstagramGraph(fetchFn, GRAPH_API_VERSION, login);
    let id: Identified;
    try {
      id = await identify(graph, token, accountId, account.handle);
    } catch (e) {
      failures.push({ login, error: e });
      continue;
    }
    // The token was accepted but is not the configured account's: a definite answer, the other API is not asked.
    if ("mismatch" in id) {
      out.error(`${id.mismatch}; nothing was saved`);
      return 1;
    }
    found = { login, graph, ...id };
    break;
  }
  if (!found) {
    if (failures.length > 1 && failures.every((f) => f.error instanceof GraphError && f.error.code === 190)) {
      out.error("token not accepted by Instagram Login nor Unified login; generate it again in Meta's app dashboard (API setup with Unified login, Generate access tokens; docs/setup.md step 4, item 6) and run this again (nothing was saved)");
    } else {
      out.error(`Instagram did not accept the token (${failures.map((f) => `${LOGIN_LABEL[f.login]}: ${safe(f.error)}`).join("; ")}); nothing was saved`);
    }
    return 1;
  }
  const { login, graph, userId, username } = found;

  if (login === "unified") {
    // An older Worker reads a null expiry as an invalid date, so a Unified login token waits for migration 0006.
    let version: number | null;
    try {
      version = await (deps.schemaVersion ?? (() => {
        const e = env();
        return schemaVersion({ supabase: { url: e.WEEKPOST_SUPABASE_URL, key: e.WEEKPOST_SUPABASE_KEY }, fetch: fetchFn });
      }))();
    } catch {
      version = null;
    }
    if (version === null || version < UNIFIED_MIN_SCHEMA) {
      out.error(
        version === null
          ? `could not read the database schema version, and a Unified login token needs schema ${UNIFIED_MIN_SCHEMA}; check the Supabase URL and key with \`npx weekpost doctor\` (nothing was saved)`
          : `the database is at schema ${version}, and a Unified login token needs schema ${UNIFIED_MIN_SCHEMA} or newer. Run \`npx weekpost setup --apply --only=db.migrate\`, then \`npx weekpost setup --apply --only=worker.deploy\`, then this again (nothing was saved)`,
      );
      return 1;
    }
  }

  try {
    await graph.publishingLimit(userId, token);
  } catch (e) {
    out.error(
      e instanceof GraphError
        ? login === "unified"
          ? `the token cannot publish (${safe(e)}); edit the Unified login configuration's permissions to include ${PUBLISH_PERMISSION.unified}, generate the token again, then run this again`
          : `the token cannot publish (${safe(e)}); generate it again with the ${PUBLISH_PERMISSION.instagram} permission and run this again`
        : `error: ${safe(e)}`,
    );
    return 1;
  }
  out.log(`token ok: @${username} (${userId}), ${LOGIN_LABEL[login]}`);
  const now = (deps.now ?? (() => new Date()))();
  // A warning, not an error: publishing works without the Insights permission, so the token is still saved.
  if ((await insightsAccess(graph, userId, token, now)) === "missing") out.log(`warning: ${noInsightsMessage(accountId, login)}`);

  let expiresAt: string | null = new Date(now.getTime() + TOKEN_DAYS * 86_400_000).toISOString();
  if (login === "unified") {
    // weekpost cannot read a Unified login token's expiry (that needs the app secret), so the user says what Meta showed.
    const days = await askValidity(deps.choose ?? askLine);
    if (days === undefined) {
      out.error('expected "never" or "60 days"; nothing was saved');
      return 1;
    }
    if (days === null) expiresAt = null;
  }

  try {
    let db = deps.db;
    if (!db) {
      const e = env();
      db = supabaseDb(e.WEEKPOST_SUPABASE_URL ?? "", e.WEEKPOST_SUPABASE_KEY ?? "");
    }
    await db.upsertToken({ account: accountId, igUserId: userId, accessToken: token, expiresAt, login });
  } catch (e) {
    out.error(`could not save the token: ${safe(e)}`);
    return 1;
  }
  out.log(`saved weekpost_tokens[${accountId}] (${LOGIN_LABEL[login]}, ${expiresAt ? `expires ${expiresAt.slice(0, 10)}` : "does not expire"})`);
  if (login === "unified" && expiresAt) {
    out.log(`warning: weekpost cannot renew a Unified login token, so this one stops working around ${expiresAt.slice(0, 10)}. Generate a new token with the expiry set to "never" and run \`npx weekpost token ${accountId}\` again.`);
  }

  if (fromClipboard) {
    try {
      await clipboard.clear();
      out.log("clipboard cleared");
    } catch {
      out.error("warning: could not clear the clipboard; clear it yourself");
    }
  }
  return 0;
}

type Identified = { userId: string; username: string } | { mismatch: string };

/** The account behind the token on one API. Throws what Meta answered when that API does not accept the token. */
async function identify(graph: InstagramGraph, token: string, accountId: string, handle: string): Promise<Identified> {
  if (graph.loginMode === "instagram") {
    const me = await graph.me(token);
    return me.username.toLowerCase() === handle.toLowerCase() ? me : { mismatch: `this token belongs to @${me.username}, but account "${accountId}" is @${handle}` };
  }
  const accounts = await graph.assignedAccounts(token);
  const match = accounts.find((a) => a.username.toLowerCase() === handle.toLowerCase());
  if (match) return { userId: match.id, username: match.username };
  if (!accounts.length) return { mismatch: `this Unified login token sees no Instagram account, but account "${accountId}" is @${handle}; pick that account when you generate the token` };
  return { mismatch: `this token sees ${accounts.map((a) => `@${a.username}`).join(", ")}, but account "${accountId}" is @${handle}` };
}

/** Days the token lasts: null for "never", 60, or undefined after three answers that are neither. */
async function askValidity(choose: (q: string) => Promise<string>): Promise<null | 60 | undefined> {
  const q =
    'How long does this token last? It is the expiry you picked in the Unified login configuration (docs/setup.md, step 4, item 5). weekpost cannot renew a Unified login token, so pick "never" there. If you are not sure, answer 60 days: doctor will warn you before it stops working. [never/60 days] (never): ';
  for (let i = 0; i < 3; i++) {
    const a = (await choose(q)).trim().toLowerCase();
    if (a === "" || a === "never" || a === "n") return null;
    if (/^60\s*(d|days?)?$/.test(a)) return 60;
  }
  return undefined;
}

async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function readPrompt(deps: TokenDeps): Promise<string> {
  // readSecret needs a name only for its messages; the token is never taken from the environment here.
  return readSecret("INSTAGRAM_TOKEN", "Paste the Instagram token (hidden)", { env: {}, tty: true, ask: deps.ask });
}
