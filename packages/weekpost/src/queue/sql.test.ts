// SQL suite for migrations/0001 to 0006. Needs a real Postgres (not part of `npm test`):
//   docker run -d --name weekpost-test-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17-alpine
//   WEEKPOST_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm run test:db
// The suite creates and drops its own databases (prefix wp_test_) and the Supabase-style roles
// service_role, anon and authenticated, so point it at a throw-away server.
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL_VAR = process.env.WEEKPOST_TEST_DATABASE_URL;
const MIGRATION_1 = readFileSync(new URL("../../migrations/0001_queue.sql", import.meta.url), "utf8");
const MIGRATION_2 = readFileSync(new URL("../../migrations/0002_media_hash.sql", import.meta.url), "utf8");
const MIGRATION_3 = readFileSync(new URL("../../migrations/0003_stale_runs.sql", import.meta.url), "utf8");
const MIGRATION_4 = readFileSync(new URL("../../migrations/0004_operator_functions.sql", import.meta.url), "utf8");
const MIGRATION_5 = readFileSync(new URL("../../migrations/0005_metrics.sql", import.meta.url), "utf8");
const MIGRATION_6 = readFileSync(new URL("../../migrations/0006_token_login.sql", import.meta.url), "utf8");
const ROLES = ["service_role", "anon", "authenticated"];
const PREFIX = "wp_test_";

function adminUrl(): string {
  if (!URL_VAR) {
    throw new Error(
      "WEEKPOST_TEST_DATABASE_URL is not set. Start a throw-away Postgres and point the suite at it:\n" +
        "  docker run -d --name weekpost-test-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17-alpine\n" +
        "  WEEKPOST_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm run test:db",
    );
  }
  return URL_VAR;
}

function urlFor(db: string): string {
  const u = new URL(adminUrl());
  u.pathname = `/${db}`;
  return u.toString();
}

let admin: Client;
const opened: Client[] = [];
let counter = 0;

async function connect(db: string): Promise<Client> {
  const c = new Client({ connectionString: urlFor(db) });
  await c.connect();
  opened.push(c);
  return c;
}

/** Creates a fresh database and applies the migrations (only the first when `upTo` is 1, the first two when 2). */
async function freshDb(upTo = 6): Promise<Client> {
  const name = `${PREFIX}${process.pid}_${counter++}`;
  await admin.query(`create database ${name}`);
  const c = await connect(name);
  await c.query(MIGRATION_1);
  if (upTo >= 2) await c.query(MIGRATION_2);
  if (upTo >= 3) await c.query(MIGRATION_3);
  if (upTo >= 4) await c.query(MIGRATION_4);
  if (upTo >= 5) await c.query(MIGRATION_5);
  if (upTo >= 6) await c.query(MIGRATION_6);
  return c;
}

async function dropTestDatabases(): Promise<void> {
  for (const c of opened.splice(0)) await c.end().catch(() => {});
  const { rows } = await admin.query("select datname from pg_database where datname like $1", [`${PREFIX}%`]);
  for (const r of rows) await admin.query(`drop database if exists ${r.datname} with (force)`);
}

async function dropRoles(): Promise<void> {
  for (const r of ROLES) await admin.query(`drop role if exists ${r}`);
}

beforeAll(async () => {
  admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  await dropTestDatabases();
  await dropRoles();
});

afterAll(async () => {
  if (!admin) return;
  await dropTestDatabases();
  await dropRoles();
  await admin.end();
});

const insertPost = (c: Client, id: string, over: Record<string, unknown> = {}) => {
  const row = {
    post_id: id, account: "en", type: "carousel", week: "2026-W44", publish_at: "2020-01-01T00:00:00Z",
    caption: "hello", media: JSON.stringify(["a.jpg", "b.jpg"]), ...over,
  };
  return c.query(
    "insert into public.weekpost_posts (post_id, account, type, week, publish_at, caption, media) values ($1,$2,$3,$4,$5,$6,$7)",
    [row.post_id, row.account, row.type, row.week, row.publish_at, row.caption, row.media],
  );
};
const POST = "2026-10-26-tip-a";
const status = async (c: Client, id = POST, account = "en") =>
  (await c.query("select status, attempts, next_attempt_at, container_id from public.weekpost_posts where post_id=$1 and account=$2", [id, account])).rows[0];

describe("0001_queue.sql: apply", () => {
  // Order matters: this runs before any Supabase role exists in the cluster.
  it("applies on a clean Postgres without the Supabase roles", async () => {
    const c = await freshDb();
    const { rows } = await c.query("select version from public.weekpost_schema");
    expect(rows).toEqual([{ version: 6 }]);
    const roles = await admin.query("select rolname from pg_roles where rolname = any($1)", [ROLES]);
    expect(roles.rows).toEqual([]);
  });

  it("applies with the Supabase roles present, granting service_role only", async () => {
    for (const r of ROLES) await admin.query(`create role ${r} nologin`);
    const c = await freshDb();
    const can = async (role: string, priv: string, table: string) =>
      (await c.query("select has_table_privilege($1, $2, $3) as ok", [role, `public.${table}`, priv])).rows[0].ok;
    for (const t of ["weekpost_posts", "weekpost_tokens", "weekpost_schema"]) {
      expect(await can("service_role", "select", t)).toBe(true);
      expect(await can("service_role", "update", t)).toBe(true);
      expect(await can("anon", "select", t)).toBe(false);
      expect(await can("authenticated", "select", t)).toBe(false);
    }
    const fn = async (role: string) =>
      (await c.query("select has_function_privilege($1, 'public.weekpost_claim(int)', 'execute') as ok", [role])).rows[0].ok;
    expect(await fn("service_role")).toBe(true);
    expect(await fn("anon")).toBe(false);
    expect(await fn("authenticated")).toBe(false);
  });

  it("enables row level security on every table", async () => {
    const c = await freshDb();
    const { rows } = await c.query(
      "select relname, relrowsecurity from pg_class where relname in ('weekpost_posts','weekpost_tokens','weekpost_schema') order by relname",
    );
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it("accepts free-text account ids and rejects malformed ones", async () => {
    const c = await freshDb();
    await insertPost(c, POST, { account: "my-shop" });
    await expect(insertPost(c, POST, { account: "Bad Account" })).rejects.toThrow(/check/);
    await expect(insertPost(c, "no-date", { account: "en" })).rejects.toThrow(/check/);
    await expect(insertPost(c, POST, { account: "en", media: JSON.stringify(["only-one.jpg"]) })).rejects.toThrow(/check/);
    await expect(insertPost(c, "2026-10-26-x", { type: "reel", media: JSON.stringify(Array(11).fill("a.mp4")) })).rejects.toThrow(/check/);
  });
});

describe("0002_media_hash.sql", () => {
  const MEDIA_HASH = "a".repeat(64);

  it("upgrades a database that already has rows: they keep their data and get a null hash", async () => {
    const c = await freshDb(1);
    await insertPost(c, POST);
    await c.query(MIGRATION_2);
    const { rows } = await c.query("select caption, media_hash, (select version from public.weekpost_schema) as version from public.weekpost_posts");
    expect(rows).toEqual([{ caption: "hello", media_hash: null, version: 2 }]);
  });

  it("accepts a sha-256 and rejects anything else", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set media_hash = $1", [MEDIA_HASH]);
    await expect(c.query("update public.weekpost_posts set media_hash = 'nope'")).rejects.toThrow(/check/);
  });

  it("freezes the media hash with the rest of the content once the post is publishing", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set media_hash = $1", [MEDIA_HASH]);
    await c.query("update public.weekpost_posts set media_hash = $1", ["b".repeat(64)]); // still scheduled: allowed
    await c.query("select * from public.weekpost_claim(1)");
    await expect(c.query("update public.weekpost_posts set media_hash = $1", [MEDIA_HASH])).rejects.toThrow(/content cannot change/);
  });

  it("an upsert by (post_id, account) moves a scheduled post to another week", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query(
      `insert into public.weekpost_posts (post_id, account, type, week, publish_at, caption, media)
       values ($1,'en','carousel','2026-W45','2030-01-01','new','["c.jpg","d.jpg"]')
       on conflict (post_id, account) do update set week = excluded.week, caption = excluded.caption, media = excluded.media`,
      [POST],
    );
    const { rows } = await c.query("select week, caption from public.weekpost_posts");
    expect(rows).toEqual([{ week: "2026-W45", caption: "new" }]);
  });

  it("an upsert cannot move a post that is publishing or published to another week", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select * from public.weekpost_claim(1)");
    const upsert = () => c.query(
      `insert into public.weekpost_posts (post_id, account, type, week, publish_at, caption, media)
       values ($1,'en','carousel','2026-W45','2030-01-01','hello','["a.jpg","b.jpg"]')
       on conflict (post_id, account) do update set week = excluded.week, publish_at = excluded.publish_at`,
      [POST],
    );
    await expect(upsert()).rejects.toThrow(/content cannot change/);
    await c.query("select public.weekpost_mark_published($1,'en',null,'m1','p')", [POST]);
    await expect(upsert()).rejects.toThrow(/content cannot change/);
  });
});

describe("0003_stale_runs.sql: source commit", () => {
  const SHA = "a".repeat(40);

  it("upgrades a database that already has rows: they keep their data and get a null commit", async () => {
    const c = await freshDb(2);
    await insertPost(c, POST);
    await c.query(MIGRATION_3);
    const { rows } = await c.query("select caption, source_commit, source_committed_at, (select version from public.weekpost_schema) as version from public.weekpost_posts");
    expect(rows).toEqual([{ caption: "hello", source_commit: null, source_committed_at: null, version: 3 }]);
  });

  it("stores a full commit sha with its instant and rejects anything else", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set source_commit = $1, source_committed_at = '2026-10-12T09:00:00Z'", [SHA]);
    await expect(c.query("update public.weekpost_posts set source_commit = 'main'")).rejects.toThrow(/check/);
    await expect(c.query("update public.weekpost_posts set source_commit = $1", [SHA.toUpperCase()])).rejects.toThrow(/check/);
  });

  it("the commit stamp can change while the post is publishing (it is not content)", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select * from public.weekpost_claim(1)");
    await c.query("update public.weekpost_posts set source_commit = $1", [SHA]);
  });
});

describe("0003_stale_runs.sql: status transitions", () => {
  // What the enqueue sends for a row it believes is new: an upsert that always carries status = 'scheduled'.
  const upsertScheduled = (c: Client, id = POST) =>
    c.query(
      `insert into public.weekpost_posts (post_id, account, type, week, publish_at, caption, media, status)
       values ($1,'en','carousel','2026-W44','2020-01-01T00:00:00Z','hello','["a.jpg","b.jpg"]','scheduled')
       on conflict (post_id, account) do update set status = excluded.status, week = excluded.week, publish_at = excluded.publish_at,
         caption = excluded.caption, media = excluded.media`,
      [id],
    );

  it("an upsert of identical content cannot move a published post back to scheduled, and it is never claimed again", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select * from public.weekpost_claim(1)");
    await c.query("select public.weekpost_mark_published($1,'en',null,'m1','https://example.test/p/1')", [POST]);
    await expect(upsertScheduled(c)).rejects.toThrow(/status cannot change/);
    expect((await status(c)).status).toBe("published");
    expect((await c.query("select * from public.weekpost_claim(10)")).rows).toHaveLength(0);
  });

  it("an upsert cannot reopen a post that is publishing (a second claim could publish it twice)", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select * from public.weekpost_claim(1)");
    await expect(upsertScheduled(c)).rejects.toThrow(/status cannot change/);
    expect((await status(c)).status).toBe("publishing");
    expect((await c.query("select * from public.weekpost_claim(10)")).rows).toHaveLength(0);
  });

  it("a direct update cannot leave publishing or published", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select * from public.weekpost_claim(1)");
    for (const to of ["scheduled", "failed", "canceled", "manual"]) {
      await expect(c.query("update public.weekpost_posts set status = $1", [to])).rejects.toThrow(/status cannot change/);
    }
    await c.query("select public.weekpost_mark_published($1,'en',null,'m1','p')", [POST]);
    await expect(c.query("update public.weekpost_posts set status = 'scheduled'")).rejects.toThrow(/status cannot change/);
  });

  it("the publisher functions still leave publishing, and the permission does not outlive them", async () => {
    const c = await freshDb();
    await insertPost(c, "2026-10-26-a");
    await insertPost(c, "2026-10-26-b");
    await c.query("select * from public.weekpost_claim(2)");
    await c.query("begin");
    await c.query("select public.weekpost_mark_failed('2026-10-26-a','en','boom','1 minute')");
    await expect(c.query("update public.weekpost_posts set status = 'scheduled' where post_id = '2026-10-26-b'")).rejects.toThrow(/status cannot change/);
    await c.query("rollback");
    await c.query("select public.weekpost_release('2026-10-26-b','en',null,'1 minute')");
    expect((await status(c, "2026-10-26-b")).status).toBe("scheduled");
  });

  it("the other moves stay free: failed, scheduled, manual, and canceled at the end", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    for (const to of ["failed", "scheduled", "manual", "scheduled", "canceled"]) {
      await c.query("update public.weekpost_posts set status = $1", [to]);
      expect((await status(c)).status).toBe(to);
    }
  });

  it("weekpost_resolve settles a stuck post as published or back to the queue, and refuses one that is not publishing", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await expect(c.query("select public.weekpost_resolve($1,'en',false,null)", [POST])).rejects.toThrow(/not in publishing/);
    await c.query("select * from public.weekpost_claim(1)");
    await c.query("select public.weekpost_resolve($1,'en',true,'https://example.test/p/9')", [POST]);
    expect((await c.query("select status, permalink, published_at from public.weekpost_posts")).rows[0]).toMatchObject({ status: "published", permalink: "https://example.test/p/9" });
    const d = await freshDb();
    await insertPost(d, POST);
    await d.query("select * from public.weekpost_claim(1)");
    await d.query("select public.weekpost_resolve($1,'en',false,null)", [POST]);
    expect(await status(d)).toMatchObject({ status: "scheduled", attempts: 0 });
  });

  it("weekpost_resolve is executable by service_role only", async () => {
    for (const r of ROLES) await admin.query(`do $$ begin if not exists (select from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
    const c = await freshDb();
    const can = async (role: string) =>
      (await c.query("select has_function_privilege($1, 'public.weekpost_resolve(text,text,boolean,text)', 'execute') as ok", [role])).rows[0].ok;
    expect(await can("service_role")).toBe(true);
    expect(await can("anon")).toBe(false);
    expect(await can("authenticated")).toBe(false);
  });
});

describe("0003_stale_runs.sql: who canceled", () => {
  const canceledBy = async (c: Client) => (await c.query("select status, canceled_by from public.weekpost_posts")).rows[0];

  it("records who canceled, defaults to the operator, and clears it when the row leaves canceled", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set status = 'canceled'");
    expect(await canceledBy(c)).toEqual({ status: "canceled", canceled_by: "operator" });
    await c.query("select public.weekpost_restore($1,'en')", [POST]);
    expect(await canceledBy(c)).toEqual({ status: "scheduled", canceled_by: null });
    await c.query("update public.weekpost_posts set status = 'canceled', canceled_by = 'enqueue'");
    expect(await canceledBy(c)).toEqual({ status: "canceled", canceled_by: "enqueue" });
    await expect(c.query("update public.weekpost_posts set canceled_by = 'someone'")).rejects.toThrow(/check/);
  });

  it("a row canceled by the enqueue can come back by a plain update (the enqueue brings it back)", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set status = 'canceled', canceled_by = 'enqueue'");
    await c.query("update public.weekpost_posts set status = 'scheduled', caption = 'back'");
    expect(await canceledBy(c)).toEqual({ status: "scheduled", canceled_by: null });
  });

  it("a row canceled by the operator cannot come back by an update or an upsert, only by weekpost_restore", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set status = 'canceled'");
    await expect(c.query("update public.weekpost_posts set status = 'scheduled'")).rejects.toThrow(/canceled by the operator/);
    await expect(
      c.query(
        `insert into public.weekpost_posts (post_id, account, type, week, publish_at, caption, media, status)
         values ($1,'en','carousel','2026-W44','2020-01-01T00:00:00Z','hello','["a.jpg","b.jpg"]','scheduled')
         on conflict (post_id, account) do update set status = excluded.status`,
        [POST],
      ),
    ).rejects.toThrow(/canceled by the operator/);
    expect((await canceledBy(c)).status).toBe("canceled");
    await c.query("select public.weekpost_restore($1,'en')", [POST]);
    expect((await canceledBy(c)).status).toBe("scheduled");
  });

  it("a row canceled before this migration counts as canceled by the operator", async () => {
    const c = await freshDb(2);
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set status = 'canceled'");
    await c.query(MIGRATION_3);
    expect(await canceledBy(c)).toEqual({ status: "canceled", canceled_by: null });
    await expect(c.query("update public.weekpost_posts set status = 'scheduled'")).rejects.toThrow(/canceled by the operator/);
  });

  it("weekpost_restore resets the attempts, enters a Story as manual, and refuses a row that is not canceled", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await expect(c.query("select public.weekpost_restore($1,'en')", [POST])).rejects.toThrow(/not canceled/);
    await insertPost(c, "2026-10-27-story", { type: "story", media: JSON.stringify(["s.jpg"]) });
    await c.query("update public.weekpost_posts set status = 'canceled', attempts = 3, last_error = 'boom', container_id = 'c1'");
    await c.query("select public.weekpost_restore($1,'en')", ["2026-10-27-story"]);
    expect((await c.query("select status, attempts, last_error, container_id from public.weekpost_posts where post_id = '2026-10-27-story'")).rows[0])
      .toEqual({ status: "manual", attempts: 0, last_error: null, container_id: null });
  });

  it("weekpost_restore is executable by service_role only", async () => {
    for (const r of ROLES) await admin.query(`do $$ begin if not exists (select from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
    const c = await freshDb();
    const can = async (role: string) => (await c.query("select has_function_privilege($1, 'public.weekpost_restore(text,text)', 'execute') as ok", [role])).rows[0].ok;
    expect(await can("service_role")).toBe(true);
    expect(await can("anon")).toBe(false);
    expect(await can("authenticated")).toBe(false);
  });
});

describe("0004_operator_functions.sql", () => {
  const row = async (c: Client) => (await c.query("select status, canceled_by, publish_at, rescheduled_at, attempts, last_error, source_commit, next_attempt_at from public.weekpost_posts")).rows[0];
  const SHA = "b".repeat(40);

  it("upgrades a 0003 database and keeps its rows", async () => {
    const c = await freshDb(3);
    await insertPost(c, POST);
    await c.query(MIGRATION_4);
    expect((await c.query("select version from public.weekpost_schema")).rows).toEqual([{ version: 4 }]);
    expect((await row(c)).status).toBe("scheduled");
  });

  it("weekpost_cancel returns the previous status, records who canceled and the commit, and clears the retry time", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set next_attempt_at = now()");
    const r = await c.query("select public.weekpost_cancel($1,'en','enqueue',$2,'2026-10-12T09:00:00Z') as prev", [POST, SHA]);
    expect(r.rows[0].prev).toBe("scheduled");
    expect(await row(c)).toMatchObject({ status: "canceled", canceled_by: "enqueue", source_commit: SHA, next_attempt_at: null });
  });

  it("weekpost_cancel keeps the stamp when none is given, and leaves an already canceled row as it was", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set source_commit = $1", [SHA]);
    await c.query("select public.weekpost_cancel($1,'en','operator',null,null)", [POST]);
    expect(await row(c)).toMatchObject({ status: "canceled", canceled_by: "operator", source_commit: SHA });
    const again = await c.query("select public.weekpost_cancel($1,'en','enqueue',null,null) as prev", [POST]);
    expect(again.rows[0].prev).toBe("canceled");
    expect((await row(c)).canceled_by).toBe("operator");
  });

  it("weekpost_cancel refuses publishing and published, an unknown post and a bad actor", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select * from public.weekpost_claim(1)");
    await expect(c.query("select public.weekpost_cancel($1,'en','operator',null,null)", [POST])).rejects.toThrow(/cannot cancel, status is publishing/);
    await c.query("select public.weekpost_mark_published($1,'en',null,'m1','p')", [POST]);
    await expect(c.query("select public.weekpost_cancel($1,'en','operator',null,null)", [POST])).rejects.toThrow(/status is published/);
    await expect(c.query("select public.weekpost_cancel('nope','en','operator',null,null)")).rejects.toThrow(/not found/);
    await expect(c.query("select public.weekpost_cancel($1,'en','someone',null,null)", [POST])).rejects.toThrow(/canceled_by must be/);
    expect((await row(c)).status).toBe("published");
  });

  it("weekpost_reschedule moves a scheduled row and stamps rescheduled_at, without touching the attempts", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select public.weekpost_reschedule($1,'en','2026-10-27T12:00:00Z',false)", [POST]);
    const r = await row(c);
    expect(new Date(r.publish_at).toISOString()).toBe("2026-10-27T12:00:00.000Z");
    expect(r.rescheduled_at).not.toBeNull();
    expect(r.status).toBe("scheduled");
  });

  it("weekpost_reschedule refuses a failed row without rearm, and rearm gives it a clean slate", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set status = 'failed', attempts = 3, last_error = 'boom'");
    await expect(c.query("select public.weekpost_reschedule($1,'en','2026-10-27T12:00:00Z',false)", [POST])).rejects.toThrow(/status is failed/);
    await c.query("select public.weekpost_reschedule($1,'en','2026-10-27T12:00:00Z',true)", [POST]);
    expect(await row(c)).toMatchObject({ status: "scheduled", attempts: 0, last_error: null });
  });

  it("weekpost_reschedule refuses rearm on a row with a media id, and every other status", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set status = 'failed', media_id = 'm1'");
    await expect(c.query("select public.weekpost_reschedule($1,'en','2026-10-27T12:00:00Z',true)", [POST])).rejects.toThrow(/media id/);
    for (const st of ["manual", "canceled"]) {
      await c.query("update public.weekpost_posts set status = $1, media_id = null", [st]);
      await expect(c.query("select public.weekpost_reschedule($1,'en','2026-10-27T12:00:00Z',true)", [POST])).rejects.toThrow(new RegExp(`status is ${st}`));
    }
    await c.query("select public.weekpost_restore($1,'en')", [POST]);
    await c.query("select * from public.weekpost_claim(1)");
    await expect(c.query("select public.weekpost_reschedule($1,'en','2026-10-27T12:00:00Z',false)", [POST])).rejects.toThrow(/status is publishing/);
    await expect(c.query("select public.weekpost_reschedule('nope','en','2026-10-27T12:00:00Z',false)")).rejects.toThrow(/not found/);
  });

  it("both functions are executable by service_role only", async () => {
    for (const r of ROLES) await admin.query(`do $$ begin if not exists (select from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
    const c = await freshDb();
    for (const fn of ["public.weekpost_cancel(text,text,text,text,timestamptz)", "public.weekpost_reschedule(text,text,timestamptz,boolean)"]) {
      const can = async (role: string) => (await c.query("select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).rows[0].ok;
      expect(await can("service_role")).toBe(true);
      expect(await can("anon")).toBe(false);
      expect(await can("authenticated")).toBe(false);
    }
  });
});

describe("weekpost_claim", () => {
  it("claims only due scheduled posts, oldest first, and counts the attempt", async () => {
    const c = await freshDb();
    await insertPost(c, "2026-10-26-b", { publish_at: "2020-01-02T00:00:00Z" });
    await insertPost(c, "2026-10-26-a", { publish_at: "2020-01-01T00:00:00Z" });
    await insertPost(c, "2026-10-26-future", { publish_at: "2999-01-01T00:00:00Z" });
    const { rows } = await c.query("select * from public.weekpost_claim(10)");
    expect(rows.map((r) => r.post_id)).toEqual(["2026-10-26-a", "2026-10-26-b"]);
    expect(rows.every((r) => r.status === "publishing" && r.attempts === 1 && r.claimed_at)).toBe(true);
    expect((await status(c, "2026-10-26-future")).status).toBe("scheduled");
  });

  it("respects the limit and skips posts waiting for a retry", async () => {
    const c = await freshDb();
    await insertPost(c, "2026-10-26-a");
    await insertPost(c, "2026-10-26-b");
    await c.query("update public.weekpost_posts set next_attempt_at = now() + interval '1 hour' where post_id = '2026-10-26-b'");
    expect((await c.query("select * from public.weekpost_claim(0)")).rows).toHaveLength(0);
    expect((await c.query("select * from public.weekpost_claim(10)")).rows.map((r) => r.post_id)).toEqual(["2026-10-26-a"]);
  });

  it("two concurrent claims never take the same row", async () => {
    const first = await freshDb();
    const dbName = (await first.query("select current_database() as d")).rows[0].d;
    await insertPost(first, "2026-10-26-a", { publish_at: "2020-01-01T00:00:00Z" });
    await insertPost(first, "2026-10-26-b", { publish_at: "2020-01-02T00:00:00Z" });
    const second = await connect(dbName);
    await second.query("set statement_timeout = 3000"); // a blocked claim fails instead of hanging

    await first.query("begin");
    const a = (await first.query("select post_id from public.weekpost_claim(1)")).rows; // row stays locked
    const b = (await second.query("select post_id from public.weekpost_claim(1)")).rows; // must skip it, not wait
    await first.query("commit");

    expect(a.map((r) => r.post_id)).toEqual(["2026-10-26-a"]);
    expect(b.map((r) => r.post_id)).toEqual(["2026-10-26-b"]);
  });

  it("a locked single row yields nothing to the second claimer", async () => {
    const first = await freshDb();
    const dbName = (await first.query("select current_database() as d")).rows[0].d;
    await insertPost(first, POST);
    const second = await connect(dbName);
    await second.query("set statement_timeout = 3000"); // a blocked claim fails instead of hanging
    await first.query("begin");
    expect((await first.query("select * from public.weekpost_claim(5)")).rows).toHaveLength(1);
    expect((await second.query("select * from public.weekpost_claim(5)")).rows).toHaveLength(0);
    await first.query("rollback");
    expect((await second.query("select * from public.weekpost_claim(5)")).rows).toHaveLength(1);
  });
});

describe("transitions", () => {
  it("mark_published stores the ids and clears the error", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select * from public.weekpost_claim(1)");
    await c.query("select public.weekpost_mark_published($1,'en','c1','m1','https://example.test/p/1')", [POST]);
    const { rows } = await c.query("select status, media_id, permalink, published_at, last_error from public.weekpost_posts");
    expect(rows[0]).toMatchObject({ status: "published", media_id: "m1", permalink: "https://example.test/p/1", last_error: null });
    expect(rows[0].published_at).toBeInstanceOf(Date);
  });

  it("mark_published and mark_failed refuse a post that is not publishing", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await expect(c.query("select public.weekpost_mark_published($1,'en',null,null,null)", [POST])).rejects.toThrow(/not in publishing/);
    await expect(c.query("select public.weekpost_mark_failed($1,'en','boom','1 minute')", [POST])).rejects.toThrow(/not in publishing/);
    await expect(c.query("select public.weekpost_release($1,'en',null,'1 minute')", [POST])).rejects.toThrow(/not in publishing/);
  });

  it("the first two failures go back to the queue, the third becomes failed", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    for (const expected of ["scheduled", "scheduled", "failed"]) {
      await c.query("update public.weekpost_posts set next_attempt_at = null");
      expect((await c.query("select * from public.weekpost_claim(1)")).rows).toHaveLength(1);
      const r = await c.query("select public.weekpost_mark_failed($1,'en','boom','10 minutes') as s", [POST]);
      expect(r.rows[0].s).toBe(expected);
    }
    const s = await status(c);
    expect(s).toMatchObject({ status: "failed", attempts: 3, next_attempt_at: null });
    const err = await c.query("select last_error from public.weekpost_posts");
    expect(err.rows[0].last_error).toBe("boom");
  });

  it("a retry waits for next_attempt_at", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select * from public.weekpost_claim(1)");
    await c.query("select public.weekpost_mark_failed($1,'en','boom','1 hour')", [POST]);
    expect((await c.query("select * from public.weekpost_claim(1)")).rows).toHaveLength(0);
  });

  it("release does not spend an attempt and keeps the container id", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select * from public.weekpost_claim(1)");
    await c.query("select public.weekpost_release($1,'en','container-1','5 minutes')", [POST]);
    expect(await status(c)).toMatchObject({ status: "scheduled", attempts: 0, container_id: "container-1" });
    // A release without a container id keeps the one already stored.
    await c.query("update public.weekpost_posts set next_attempt_at = null");
    await c.query("select * from public.weekpost_claim(1)");
    await c.query("select public.weekpost_release($1,'en',null,'5 minutes')", [POST]);
    expect((await status(c)).container_id).toBe("container-1");
  });
});

describe("content guard trigger", () => {
  it("refuses content changes while publishing and after published", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("select * from public.weekpost_claim(1)");
    await expect(c.query("update public.weekpost_posts set caption = 'other'")).rejects.toThrow(/content cannot change/);
    await expect(c.query("update public.weekpost_posts set publish_at = now()")).rejects.toThrow(/content cannot change/);
    await c.query("select public.weekpost_mark_published($1,'en',null,'m1','p')", [POST]);
    await expect(c.query("update public.weekpost_posts set media = '[\"x.jpg\",\"y.jpg\"]'")).rejects.toThrow(/content cannot change/);
  });

  it("allows content changes while scheduled and non-content changes while publishing", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set caption = 'edited', rescheduled_at = now()");
    expect((await c.query("select caption, rescheduled_at from public.weekpost_posts")).rows[0].caption).toBe("edited");
    await c.query("select * from public.weekpost_claim(1)");
    await c.query("update public.weekpost_posts set container_id = 'c9'");
    expect((await status(c)).container_id).toBe("c9");
  });

  it("moves updated_at on every update", async () => {
    const c = await freshDb();
    await insertPost(c, POST);
    await c.query("update public.weekpost_posts set updated_at = '2000-01-01'");
    await c.query("update public.weekpost_posts set caption = 'x'");
    const { rows } = await c.query("select updated_at > '2020-01-01' as moved from public.weekpost_posts");
    expect(rows[0].moved).toBe(true);
  });
});

describe("weekpost_tokens", () => {
  it("validates the account id and the token length", async () => {
    const c = await freshDb();
    const ins = (account: string, uid: string, token: string) =>
      c.query("insert into public.weekpost_tokens (account, ig_user_id, access_token, expires_at) values ($1,$2,$3, now() + interval '60 days')", [account, uid, token]);
    await ins("en", "12345", "x".repeat(30));
    await expect(ins("EN", "12345", "x".repeat(30))).rejects.toThrow(/check/);
    await expect(ins("fr", "abc", "x".repeat(30))).rejects.toThrow(/check/);
    await expect(ins("de", "123", "short")).rejects.toThrow(/check/);
  });
});

describe("0005_metrics.sql", () => {
  const metric = (c: Client, over: Record<string, unknown> = {}) => {
    const r = { scope: "post", post_id: POST, account: "en", collected_on: "2026-10-30", metric: "reach", value: 29, ...over };
    return c.query("insert into public.weekpost_metrics (scope, post_id, account, collected_on, metric, value) values ($1,$2,$3,$4,$5,$6)",
      [r.scope, r.post_id, r.account, r.collected_on, r.metric, r.value]);
  };

  it("applies on top of 0004 and moves the schema to 5", async () => {
    const c = await freshDb(5);
    expect((await c.query("select version from public.weekpost_schema")).rows).toEqual([{ version: 5 }]);
  });

  it("has row level security and grants only to service_role", async () => {
    for (const r of ROLES) await admin.query(`create role ${r} nologin`).catch(() => {});
    const c = await freshDb();
    expect((await c.query("select relrowsecurity from pg_class where relname = 'weekpost_metrics'")).rows).toEqual([{ relrowsecurity: true }]);
    const can = async (role: string, priv: string) => (await c.query("select has_table_privilege($1, 'public.weekpost_metrics', $2) as ok", [role, priv])).rows[0].ok;
    expect(await can("service_role", "insert")).toBe(true);
    expect(await can("service_role", "update")).toBe(true);
    expect(await can("anon", "select")).toBe(false);
    expect(await can("authenticated", "select")).toBe(false);
  });

  it("keys a number by scope, post, account, day and metric", async () => {
    const c = await freshDb();
    await metric(c);
    await expect(metric(c)).rejects.toThrow(/duplicate key/);
    await metric(c, { metric: "views" });
    await metric(c, { collected_on: "2026-11-06" });
    await metric(c, { scope: "account", post_id: "" });
  });

  it("refuses negative values, a post scope without a post, an account scope with one, and bad names", async () => {
    const c = await freshDb();
    await expect(metric(c, { value: -1 })).rejects.toThrow(/check/);
    await expect(metric(c, { post_id: "" })).rejects.toThrow(/check/);
    await expect(metric(c, { scope: "account" })).rejects.toThrow(/check/);
    await expect(metric(c, { scope: "other" })).rejects.toThrow(/check/);
    await expect(metric(c, { metric: "Reach; drop" })).rejects.toThrow(/check/);
    await expect(metric(c, { account: "Bad Account" })).rejects.toThrow(/check/);
  });

  it("stores values past 32 bits", async () => {
    const c = await freshDb();
    await metric(c, { value: "5000000000" });
    expect((await c.query("select value::text from public.weekpost_metrics")).rows).toEqual([{ value: "5000000000" }]);
  });

  it("upserts through PostgREST-style on conflict", async () => {
    const c = await freshDb();
    const up = (v: number) => c.query(
      "insert into public.weekpost_metrics (scope, post_id, account, collected_on, metric, value) values ('post',$1,'en','2026-10-30','reach',$2) on conflict (scope, post_id, account, collected_on, metric) do update set value = excluded.value",
      [POST, v]);
    await up(1);
    await up(2);
    expect((await c.query("select value::int from public.weekpost_metrics")).rows).toEqual([{ value: 2 }]);
  });
});

describe("0006_token_login.sql", () => {
  const insertToken = (c: Client, account: string, expires: string | null, login?: string) =>
    login === undefined
      ? c.query("insert into public.weekpost_tokens (account, ig_user_id, access_token, expires_at) values ($1,'12345',$2,$3)", [account, "x".repeat(30), expires])
      : c.query("insert into public.weekpost_tokens (account, ig_user_id, access_token, expires_at, login) values ($1,'12345',$2,$3,$4)", [account, "x".repeat(30), expires, login]);

  it("upgrades a 0005 database: existing tokens become instagram and keep their expiry", async () => {
    const c = await freshDb(5);
    await insertToken(c, "en", "2026-12-28T12:00:00Z");
    await c.query(MIGRATION_6);
    expect((await c.query("select version from public.weekpost_schema")).rows).toEqual([{ version: 6 }]);
    const { rows } = await c.query("select account, login, expires_at from public.weekpost_tokens");
    expect(rows).toEqual([{ account: "en", login: "instagram", expires_at: new Date("2026-12-28T12:00:00Z") }]);
  });

  it("defaults to instagram, accepts unified and a null expiry, and refuses another mode", async () => {
    const c = await freshDb();
    await insertToken(c, "en", "2026-12-28T12:00:00Z");
    await insertToken(c, "pt", null, "unified");
    await insertToken(c, "es", null);
    await expect(insertToken(c, "de", null, "facebook")).rejects.toThrow(/check/);
    const { rows } = await c.query("select account, login, expires_at is null as no_expiry from public.weekpost_tokens order by account");
    expect(rows).toEqual([
      { account: "en", login: "instagram", no_expiry: false },
      { account: "es", login: "instagram", no_expiry: true },
      { account: "pt", login: "unified", no_expiry: true },
    ]);
  });

  it("keeps the 0005 behavior of the previous Worker: it writes tokens without `login` and a refresh keeps the mode", async () => {
    const c = await freshDb();
    await insertToken(c, "en", "2026-12-28T12:00:00Z", "unified");
    await c.query("update public.weekpost_tokens set access_token = $1, expires_at = now() + interval '60 days' where account = 'en'", ["y".repeat(30)]);
    expect((await c.query("select login from public.weekpost_tokens")).rows).toEqual([{ login: "unified" }]);
  });
});
