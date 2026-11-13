// Guards the "a 0.x migration only adds" rule (docs/releasing.md): between running a migration and deploying the new
// Worker, the previous Worker keeps calling the database. For every migration N >= 2 this suite
//   1. applies 0001..N-1 on a clean database,
//   2. runs every call the database adapter makes (the real `supabaseDb` adapter, see CALLS),
//   3. applies N,
//   4. runs the same calls again,
// and fails, naming the migration and the function or column, if a call that worked before no longer finds what it
// used (a dropped function, a changed signature, a removed or renamed column or table) or if a result lost a column.
//
// How the calls are made: the real adapter in src/queue/supabase.ts runs against a fake `fetch` that turns each
// PostgREST request (rpc, select, PATCH, upsert) into the equivalent SQL on a real Postgres. So the signatures,
// columns and filters come from the adapter code itself, not from a copy.
//
// What needs upkeep: CALLS below lists one scenario per adapter method. A test fails when the adapter gains a method
// that CALLS does not cover, so extend CALLS (and, if it needs rows in some state, `seed`) with every new adapter function.
//
// Needs a real Postgres, like sql.test.ts (`npm run test:db`); it runs after the other SQL suites, never beside them.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMigrations, type Migration } from "./migrate.ts";
import { supabaseDb } from "../queue/supabase.ts";
import type { Db, MetricsDb } from "../queue/types.ts";

const URL_VAR = process.env.WEEKPOST_TEST_DATABASE_URL;
const PREFIX = `wp_test_expand_${process.pid}_`;
const migrations = readMigrations();

/** SQLSTATEs that mean "the schema no longer has what the call uses". Business refusals (P0001, 23xxx) are not breaks. */
const STRUCTURAL: Record<string, string> = {
  "42883": "function or signature not found",
  "42703": "column not found",
  "42P01": "table not found",
  "42P02": "parameter not found",
  "42704": "object or type not found",
  "42P10": "no unique constraint for the upsert key",
};

interface Outcome { sqlstate: string | null; message: string | null; columns: string[] | null }

// ---------------------------------------------------------------------------------------------------------------------
// PostgREST -> SQL, only the subset the adapter uses.
// ---------------------------------------------------------------------------------------------------------------------

const ident = (s: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unexpected identifier in a PostgREST request: ${s}`);
  return `"${s}"`;
};
const text = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

function where(params: [string, string][], args: (string | null)[]): string {
  const out: string[] = [];
  for (const [col, expr] of params) {
    if (["select", "order", "limit", "on_conflict"].includes(col)) continue;
    const dot = expr.indexOf(".");
    const op = expr.slice(0, dot);
    const val = expr.slice(dot + 1);
    const c = ident(col);
    const bind = (v: string | null) => { args.push(v); return `$${args.length}`; };
    if (op === "eq") out.push(`${c} = ${bind(val)}`);
    else if (op === "lt") out.push(`${c} < ${bind(val)}`);
    else if (op === "gte") out.push(`${c} >= ${bind(val)}`);
    else if (op === "is" && val === "null") out.push(`${c} is null`);
    else if (op === "in") out.push(`${c} in (${val.slice(1, -1).split(",").map(bind).join(", ")})`);
    else throw new Error(`unexpected PostgREST filter: ${col}=${expr}`);
  }
  return out.length ? ` where ${out.join(" and ")}` : "";
}

type Run = { rows: unknown[]; fields: string[] };
const run = async (c: Client, sql: string, args: (string | null)[]): Promise<Run> => {
  const r = await c.query(sql, args);
  return { rows: r.rows, fields: r.fields.map((f) => f.name) };
};

/** Executes one request the way PostgREST would. Returns the JSON body and the result columns. */
async function execute(c: Client, method: string, path: string, body: unknown): Promise<{ body: unknown; columns: string[] | null }> {
  const url = new URL(path, "http://postgrest.invalid");
  const params = [...url.searchParams.entries()];
  const rpc = /^\/rest\/v1\/rpc\/([a-z_0-9]+)$/.exec(url.pathname);
  if (rpc) {
    const fn = ident(rpc[1]!);
    const entries = Object.entries((body ?? {}) as Record<string, unknown>);
    const args = entries.map(([, v]) => text(v));
    const call = `public.${fn}(${entries.map(([k], i) => `${ident(k)} := $${i + 1}`).join(", ")})`;
    const { rows: meta } = await c.query("select proretset from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1", [rpc[1]]);
    if (meta[0]?.proretset) {
      const r = await run(c, `select * from ${call}`, args);
      return { body: JSON.parse(JSON.stringify(r.rows)), columns: r.fields };
    }
    // A scalar function, or a function that does not exist: the select reports the missing one with PostgreSQL's own error.
    const r = await run(c, `select ${call} as r`, args);
    const v = (r.rows[0] as { r: unknown }).r;
    return { body: v === "" ? null : v, columns: null };
  }
  const table = ident(url.pathname.replace("/rest/v1/", ""));
  const args: (string | null)[] = [];
  if (method === "GET") {
    const sel = url.searchParams.get("select") ?? "*";
    const cols = sel === "*" ? "*" : sel.split(",").map(ident).join(", ");
    const order = url.searchParams.get("order");
    const limit = url.searchParams.get("limit");
    const sql = `select ${cols} from public.${table}${where(params, args)}` +
      (order ? ` order by ${order.split(",").map(ident).join(", ")}` : "") + (limit ? ` limit ${Number(limit)}` : "");
    const r = await run(c, sql, args);
    return { body: JSON.parse(JSON.stringify(r.rows)), columns: r.fields };
  }
  if (method === "PATCH") {
    const set = body as Record<string, unknown>;
    args.push(JSON.stringify(set));
    const sets = Object.keys(set).map((k) => `${ident(k)} = (json_populate_record(null::public.${table}, $1::json)).${ident(k)}`).join(", ");
    const r = await run(c, `update public.${table} set ${sets}${where(params, args)} returning *`, args);
    return { body: JSON.parse(JSON.stringify(r.rows)), columns: r.fields };
  }
  if (method === "POST") {
    const list = body as Record<string, unknown>[];
    const cols = Object.keys(list[0]!);
    args.push(JSON.stringify(list));
    const conflict = url.searchParams.get("on_conflict")?.split(",");
    const upsert = conflict ? ` on conflict (${conflict.map(ident).join(", ")}) do update set ${cols.filter((k) => !conflict.includes(k)).map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ")}` : "";
    await run(c, `insert into public.${table} (${cols.map(ident).join(", ")}) select ${cols.map(ident).join(", ")} from json_populate_recordset(null::public.${table}, $1::json)${upsert}`, args);
    return { body: null, columns: null };
  }
  throw new Error(`unexpected request: ${method} ${path}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The calls.
// ---------------------------------------------------------------------------------------------------------------------

type Adapter = Db & MetricsDb;
const NOW = "2026-10-27T12:00:00.000Z";
const LATER = "2030-01-01T00:00:00.000Z";
const id = (round: number, n: number) => `2026-10-26-r${round}p${n}`;
const key = (round: number, n: number) => ({ postId: id(round, n), account: "en" });

/** Rows in the state each call needs, written with the columns of migration 0001 only so any N-1 can hold them. */
async function seed(c: Client, round: number): Promise<void> {
  for (let n = 1; n <= 8; n++) {
    await c.query(
      "insert into public.weekpost_posts (post_id, account, type, week, publish_at, caption, media) values ($1,'en','carousel','2026-W44','2020-01-01T00:00:00Z','hello',$2)",
      [id(round, n), JSON.stringify(["a.jpg", "b.jpg"])],
    );
  }
  // p8 stays out of the claim below (published later by the calls); p6 and p7 get states a claim cannot reach.
  await c.query("update public.weekpost_posts set publish_at = $1 where post_id = $2", [LATER, id(round, 8)]);
  await c.query(
    "insert into public.weekpost_tokens (account, ig_user_id, access_token, expires_at) values ('en','123','x'||repeat('t', 30),'2030-01-01') on conflict (account) do nothing",
  );
}

/**
 * ONE scenario per adapter method, in an order that gives each call a row in the state it needs. Every method of
 * `supabaseDb` must appear here (checked by a test): extend this list for each new adapter function.
 */
const CALLS: Record<keyof Adapter, (db: Adapter, round: number) => Promise<unknown>> = {
  rows: (db, r) => db.rows({ week: "2026-W44", status: ["scheduled", "manual"], key: key(r, 1) }),
  insert: (db, r) => db.insert([{
    postId: id(r, 9), account: "en", type: "carousel", week: "2026-W44", publishAt: LATER, caption: "new", media: ["a.jpg", "b.jpg"],
    cover: null, link: null, contentHash: "c".repeat(64), mediaHash: "d".repeat(64), status: "scheduled",
  }]),
  updateContent: async (db, r) => {
    const c = { caption: "edited", publishAt: LATER, media: ["a.jpg", "b.jpg"], cover: null, link: null, contentHash: "e".repeat(64), mediaHash: "f".repeat(64) };
    await db.updateContent(key(r, 1), c);
    await db.cancel(key(r, 2), "enqueue");
    await db.updateContent(key(r, 2), c, { revive: true });
  },
  cancel: (db, r) => db.cancel(key(r, 3), "operator", { sourceCommit: "a".repeat(40), sourceCommittedAt: NOW }),
  restore: (db, r) => db.restore(key(r, 3)),
  reschedule: (db, r) => db.reschedule(key(r, 1), LATER, { rearm: false }),
  claim: (db) => db.claim(5),
  setContainer: (db, r) => db.setContainer(key(r, 4), "container-1"),
  markPublished: (db, r) => db.markPublished(key(r, 4), { containerId: "container-1", mediaId: "media-1", permalink: "https://example.invalid/p/1" }),
  markFailed: (db, r) => db.markFailed(key(r, 5), "boom", 60),
  release: (db, r) => db.release(key(r, 6), "container-2", 60),
  resolveStuck: (db, r) => db.resolveStuck(key(r, 7), { published: true, permalink: "https://example.invalid/p/7" }),
  duePurge: (db) => db.duePurge("2031-01-01T00:00:00.000Z", 10),
  markPurged: (db, r) => db.markPurged(key(r, 4)),
  stuck: (db) => db.stuck("2031-01-01T00:00:00.000Z"),
  publishedSince: (db) => db.publishedSince("2020-01-01T00:00:00.000Z"),
  failed: (db) => db.failed(),
  overdue: (db) => db.overdue("2031-01-01T00:00:00.000Z"),
  manualDue: (db) => db.manualDue("2020-01-01T00:00:00.000Z", "2031-01-01T00:00:00.000Z"),
  tokens: (db) => db.tokens(),
  saveToken: async (db) => {
    const [t] = await db.tokens();
    await db.saveToken("en", t!.refreshedAt, "y".repeat(30), "2031-01-01T00:00:00.000Z");
  },
  upsertToken: (db) => db.upsertToken({ account: "en", igUserId: "123", accessToken: "z".repeat(30), expiresAt: "2031-01-01T00:00:00.000Z", login: "instagram" }),
  upsertMetrics: (db) => db.upsertMetrics([{ scope: "post", postId: id(1, 1), account: "en", collectedOn: "2026-10-27", metric: "reach", value: 10 }]),
  metricsSince: (db) => db.metricsSince("2020-01-01"),
};

/** Runs every call once against `c`, recording per request whether it hit a missing function/column and which columns it got back. */
async function runCalls(c: Client, round: number): Promise<Map<string, Outcome>> {
  await seed(c, round);
  const out = new Map<string, Outcome>();
  let current = "";
  let n = 0;
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const path = input.replace("http://db.invalid", "");
    const label = `${current} (${init.method ?? "GET"} ${path.split("?")[0]!.replace("/rest/v1/", "")}) #${++n}`;
    try {
      const r = await execute(c, init.method ?? "GET", path, init.body ? JSON.parse(String(init.body)) : undefined);
      out.set(label, { sqlstate: null, message: null, columns: r.columns });
      return new Response(r.body === null ? "" : JSON.stringify(r.body), { status: 200 });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      out.set(label, { sqlstate: err.code ?? "XX000", message: err.message ?? String(e), columns: null });
      return new Response(JSON.stringify({ code: err.code, message: err.message }), { status: 400 });
    }
  }) as unknown as typeof fetch;
  const db = supabaseDb("http://db.invalid", "sb_secret_test", fetchFn);
  for (const [name, call] of Object.entries(CALLS)) {
    current = name;
    n = 0;
    await call(db, round).catch(() => {}); // a refusal (wrong state, bad value) is not a schema break; structural errors are read from `out`
  }
  return out;
}

const isStructural = (o: Outcome) => o.sqlstate !== null && o.sqlstate in STRUCTURAL;

/** What the previous Worker can no longer do: calls that worked before and now hit a missing function/column or lost a result column. */
export function brokenBy(file: string, before: Map<string, Outcome>, after: Map<string, Outcome>): string[] {
  const problems: string[] = [];
  for (const [label, was] of before) {
    if (isStructural(was)) continue; // did not work before either (the feature arrives in a later migration)
    const now = after.get(label);
    if (!now) continue;
    if (isStructural(now)) {
      problems.push(`${file} broke ${label}: ${STRUCTURAL[now.sqlstate!]} (${now.message})`);
    } else if (was.columns && now.columns) {
      const lost = was.columns.filter((col) => !now.columns!.includes(col));
      if (lost.length) problems.push(`${file} broke ${label}: result no longer has column(s) ${lost.join(", ")}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------

let admin: Client;
const opened: Client[] = [];
const created: string[] = [];

async function freshDb(upTo: number): Promise<Client> {
  const name = `${PREFIX}${created.length}`;
  created.push(name);
  await admin.query(`create database ${name}`);
  const u = new URL(URL_VAR!);
  u.pathname = `/${name}`;
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  opened.push(c);
  for (const m of migrations.filter((m) => m.version <= upTo)) await c.query(m.sql);
  return c;
}

beforeAll(async () => {
  if (!URL_VAR) throw new Error("WEEKPOST_TEST_DATABASE_URL is not set (see src/queue/sql.test.ts)");
  admin = new Client({ connectionString: URL_VAR });
  await admin.connect();
});

afterAll(async () => {
  for (const c of opened) await c.end().catch(() => {});
  if (!admin) return;
  for (const name of created) await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
});

describe("the call list", () => {
  it("covers every method of the database adapter", () => {
    const methods = Object.keys(supabaseDb("http://db.invalid", "sb_secret_test", (() => {}) as never)).sort();
    expect(Object.keys(CALLS).sort(), "extend CALLS with each new adapter function").toEqual(methods);
  });

  it("all work on the full schema", async () => {
    const c = await freshDb(migrations.at(-1)!.version);
    const out = await runCalls(c, 1);
    const broken = [...out].filter(([, o]) => isStructural(o)).map(([l, o]) => `${l}: ${o.message}`);
    expect(broken).toEqual([]);
    expect(out.size).toBeGreaterThan(Object.keys(CALLS).length - 1);
  });
});

describe("a migration only adds", () => {
  const later: Migration[] = migrations.filter((m) => m.version >= 2);
  for (const m of later) {
    it(`${m.file} keeps every call of the previous Worker working`, async () => {
      const c = await freshDb(m.version - 1);
      const before = await runCalls(c, 1);
      expect([...before.values()].some((o) => !isStructural(o)), "baseline ran nothing").toBe(true);
      await c.query(m.sql);
      const after = await runCalls(c, 2);
      expect(brokenBy(m.file, before, after)).toEqual([]);
    });
  }

  it("names the migration and the function when one drops a function", async () => {
    const last = migrations.at(-1)!.version;
    const c = await freshDb(last);
    const before = await runCalls(c, 1);
    await c.query("drop function public.weekpost_cancel(text, text, text, text, timestamptz)");
    const after = await runCalls(c, 2);
    const problems = brokenBy("9999_drop.sql", before, after);
    expect(problems.join("\n")).toMatch(/9999_drop\.sql broke cancel .*function or signature not found.*weekpost_cancel/);
  });

  it("names the column when one drops a column", async () => {
    const c = await freshDb(migrations.at(-1)!.version);
    const before = await runCalls(c, 1);
    await c.query("alter table public.weekpost_posts drop column permalink");
    const after = await runCalls(c, 2);
    expect(brokenBy("9999_drop.sql", before, after).join("\n")).toMatch(/9999_drop\.sql broke .*permalink/);
  });
});
