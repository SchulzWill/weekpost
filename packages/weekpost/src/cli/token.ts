// weekpost token <account> [--prompt] [--project=<dir>]
// Reads a long-lived Instagram token from the clipboard (or a hidden prompt), checks on the Graph API that it
// belongs to the account named in the config and may publish, then saves it in `weekpost_tokens` and clears the
// clipboard. Needs a terminal. The token is never printed: not on success, not in any error.
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/load.ts";
import { ConfigError } from "../config/parse.ts";
import type { WeekpostConfig } from "../config/schema.ts";
import { insightsAccess, noInsightsMessage } from "../metrics/access.ts";
import { GraphError, InstagramGraph, redact } from "../publisher/instagram.ts";
import { supabaseDb } from "../queue/supabase.ts";
import type { OperatorDb } from "../queue/types.ts";
import { projectPaths, type Out } from "./check.ts";
import { positional } from "./queueCommon.ts";
import { readSecret, requireTty, SecretError, withLocalEnv } from "./secrets.ts";

/** The token of the Instagram panel lasts 60 days; we record 59 so a refresh is never late. */
export const TOKEN_DAYS = 59;

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
  if (!accountId) {
    out.error("usage: weekpost token <account> [--prompt]");
    return 2;
  }
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
  const dbKey = (deps.env ?? process.env).WEEKPOST_SUPABASE_KEY ?? "";
  // Defense in depth: the adapters already scrub their messages; this scrubs the token and the service key again.
  const safe = (e: unknown) => redact(redact(String((e as Error)?.message ?? e), token), dbKey);

  const graph = new InstagramGraph(deps.fetch ?? fetch);
  let me: { userId: string; username: string };
  try {
    me = await graph.me(token);
  } catch (e) {
    out.error(`Instagram did not accept the token: ${safe(e)}`);
    return 1;
  }
  if (me.username.toLowerCase() !== account.handle.toLowerCase()) {
    out.error(`this token belongs to @${me.username}, but account "${accountId}" is @${account.handle}; nothing was saved`);
    return 1;
  }
  try {
    await graph.publishingLimit(me.userId, token);
  } catch (e) {
    out.error(
      e instanceof GraphError
        ? `the token cannot publish (${safe(e)}); generate it again with the instagram_business_content_publish permission and run this again`
        : `error: ${safe(e)}`,
    );
    return 1;
  }
  out.log(`token ok: @${me.username} (${me.userId})`);
  const now = (deps.now ?? (() => new Date()))();
  // A warning, not an error: publishing works without the Insights permission, so the token is still saved.
  if ((await insightsAccess(graph, me.userId, token, now)) === "missing") out.log(`warning: ${noInsightsMessage(accountId)}`);

  const expiresAt = new Date(now.getTime() + TOKEN_DAYS * 86_400_000).toISOString();
  try {
    let db = deps.db;
    if (!db) {
      const env = withLocalEnv(deps.env ?? process.env, projectRoot, deps.home, { tty: true });
      db = supabaseDb(env.WEEKPOST_SUPABASE_URL ?? "", env.WEEKPOST_SUPABASE_KEY ?? "");
    }
    await db.upsertToken({ account: accountId, igUserId: me.userId, accessToken: token, expiresAt });
  } catch (e) {
    out.error(`could not save the token: ${safe(e)}`);
    return 1;
  }
  out.log(`saved weekpost_tokens[${accountId}] (expires ${expiresAt.slice(0, 10)})`);

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

function readPrompt(deps: TokenDeps): Promise<string> {
  // readSecret needs a name only for its messages; the token is never taken from the environment here.
  return readSecret("INSTAGRAM_TOKEN", "Paste the Instagram token (hidden)", { env: {}, tty: true, ask: deps.ask });
}
