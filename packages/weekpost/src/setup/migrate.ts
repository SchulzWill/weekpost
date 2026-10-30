// `db.migrate` and `storage.bucket`: the two steps that write to Supabase.
// DDL needs a direct Postgres connection (the REST API cannot run it), so the migrations go through `pg` with a
// connection string typed at a hidden prompt (or set in DATABASE_URL by you). The string is used once and never saved.
// Every migration file is its own transaction (the files carry their own begin/commit and bump `weekpost_schema`).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SupabaseError } from "../queue/supabase.ts";
import { supabaseStorage } from "../queue/storage.ts";
import { ApplyError, type Action, type Actions } from "./apply.ts";
import { probe, schemaVersion } from "./probes.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

export type Migration = { version: number; file: string; sql: string };

/** The queue client we need from `pg`; tests pass a fake. */
export interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
export type PgFactory = (connectionString: string) => PgClient;

export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = /^(\d{4})_.*\.sql$/.exec(file);
    if (m) out.push({ version: Number(m[1]), file, sql: readFileSync(join(dir, file), "utf8") });
  }
  return out;
}

export const pendingAfter = (all: Migration[], current: number): Migration[] => all.filter((m) => m.version > current);

/** The SQL for `--print`: the pending files in order, each under a comment naming it. */
export function printable(pending: Migration[]): string {
  return pending.map((m) => `-- ${m.file}\n${m.sql.trimEnd()}\n`).join("\n");
}

const CONNECTION = /^postgres(?:ql)?:\/\/\S+$/;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type PgTls = { connectionString: string; ssl: false | { rejectUnauthorized: boolean }; verified: boolean };

/**
 * TLS rules for the direct connection (it carries DDL and the database password). Only a local host may go without.
 * Anything else needs `sslmode=require` (or no sslmode at all), or `verify-ca` / `verify-full`; `disable`, `allow` and
 * `prefer` are refused. Supabase recommends `verify-full` with its CA certificate downloaded from the dashboard
 * (`sslrootcert=/path/prod-ca-2021.crt`); that is passed to `pg` untouched and the certificate is verified. With
 * `require` the traffic is encrypted but the certificate is not checked, because Node does not trust Supabase's CA by
 * default. https://supabase.com/docs/guides/platform/ssl-enforcement
 */
export function pgTls(connectionString: string): PgTls {
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    throw new ApplyError("that is not a postgres:// connection string");
  }
  if (LOCAL_HOSTS.has(u.hostname)) return { connectionString, ssl: false, verified: false };
  const mode = u.searchParams.get("sslmode");
  if (mode && !["require", "verify-ca", "verify-full"].includes(mode)) {
    throw new ApplyError(`sslmode=${mode} sends the password and the SQL without TLS; use sslmode=require, or verify-full with the Supabase CA`);
  }
  if (mode === "verify-ca" || mode === "verify-full") return { connectionString, ssl: false, verified: true };
  u.searchParams.delete("sslmode");
  return { connectionString: u.toString(), ssl: { rejectUnauthorized: false }, verified: false };
}

async function realPg(connectionString: string): Promise<PgClient> {
  const { default: pg } = await import("pg");
  const tls = pgTls(connectionString);
  return new pg.Client({ connectionString: tls.connectionString, ...(tls.ssl ? { ssl: tls.ssl } : {}) }) as unknown as PgClient;
}

/** An error message without the connection string, its password, or anything that could echo them. */
function safeMessage(e: unknown, connectionString: string): string {
  const code = (e as { code?: unknown })?.code;
  let text = String((e as Error)?.message ?? "error");
  const parts = [connectionString];
  try {
    const u = new URL(connectionString);
    if (u.password) parts.push(u.password, decodeURIComponent(u.password));
  } catch {
    /* not a URL: the whole string is already scrubbed */
  }
  for (const p of parts.filter(Boolean)) text = text.split(p).join("[redacted]");
  return `${typeof code === "string" ? `${code}: ` : ""}${text}`.slice(0, 300);
}

/**
 * Applies the migrations the database does not have yet, in order, on one connection. What is pending is read from
 * the database itself. A file that fails is rolled back and the run stops there; the files before it stay applied.
 * After each file the recorded version must equal the file's number. Returns how many files it applied.
 */
export async function applyMigrations(client: PgClient, all: Migration[], log: (line: string) => void, connectionString: string): Promise<number> {
  try {
    await client.connect();
  } catch (e) {
    throw new ApplyError(`could not connect to the database: ${safeMessage(e, connectionString)}`);
  }
  let applied = 0;
  try {
    const table = await client.query("select to_regclass('public.weekpost_schema') as t");
    const current = table.rows[0]?.t ? Number((await client.query("select max(version) as version from public.weekpost_schema")).rows[0]?.version) || 0 : 0;
    const pending = pendingAfter(all, current);
    if (pending.length === 0) log("  nothing pending");
    for (const m of pending) {
      log(`  applying ${m.file}`);
      try {
        await client.query(m.sql);
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw new ApplyError(`${m.file} failed and was rolled back: ${safeMessage(e, connectionString)}`);
      }
      const { rows } = await client.query("select max(version) as version from public.weekpost_schema");
      const recorded = Number(rows[0]?.version);
      if (recorded !== m.version) throw new ApplyError(`${m.file} ran but weekpost_schema says ${Number.isNaN(recorded) ? "nothing" : recorded}, expected ${m.version}`);
      applied++;
    }
    // PostgREST caches the schema; without this the new tables answer 404 for a while.
    if (applied) await client.query("notify pgrst, 'reload schema'").catch(() => {});
  } finally {
    await client.end().catch(() => {});
  }
  return applied;
}

export function migrateAction(deps: { pg?: PgFactory; migrations?: Migration[] } = {}): Action {
  return async (io) => {
    const all = deps.migrations ?? readMigrations();
    const ctx = io.context();

    if (io.options.print) {
      // Read what the database has over REST when we can; without credentials print everything.
      const pending = pendingAfter(all, (await schemaVersion(ctx)) ?? 0);
      if (pending.length === 0) return;
      io.out.log(`\n${printable(pending)}`);
      io.out.log("  paste the SQL above into the SQL editor of your Supabase project, then run `weekpost setup --apply` again to check it");
      return;
    }

    const connectionString = await io.secret("DATABASE_URL");
    if (!CONNECTION.test(connectionString)) throw new ApplyError("that is not a postgres:// connection string");
    const tls = pgTls(connectionString); // refuse a remote host without TLS before anything is sent
    if (!tls.verified && tls.ssl) io.out.log("  TLS is on but the certificate is not verified; add sslmode=verify-full&sslrootcert=<Supabase CA file> to verify it");
    const client = deps.pg ? deps.pg(connectionString) : await realPg(connectionString);
    await applyMigrations(client, all, (l) => io.out.log(l), connectionString);
  };
}

export const bucketAction: Action = async (io) => {
  const url = await io.secret("WEEKPOST_SUPABASE_URL");
  const key = await io.secret("WEEKPOST_SUPABASE_KEY");
  const ctx = io.context();
  try {
    await supabaseStorage(url, key, ctx.bucket, ctx.fetch).ensureBucket();
  } catch (e) {
    throw new ApplyError(e instanceof SupabaseError ? e.message : "could not create the bucket");
  }
  // An existing bucket is left alone, so check it really is the private one we need.
  const after = await probe(io.context(), "storage.bucket");
  if (after.state !== "ok") throw new ApplyError(after.detail);
};

export const dbActions = (deps: Parameters<typeof migrateAction>[0] = {}): Actions => ({
  "db.migrate": migrateAction(deps),
  "storage.bucket": bucketAction,
});
