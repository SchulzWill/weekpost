import { describe, expect, it } from "vitest";
import { runApply, type ApplyIO } from "../src/setup/apply.ts";
import { applyMigrations, bucketAction, migrateAction, pendingAfter, pgTls, printable, readMigrations, type Migration, type PgClient } from "../src/setup/migrate.ts";
import type { SetupContext } from "../src/setup/steps.ts";

const PASSWORD = "SENTINEL-pw-4d3c2b1a";
const CONN = `postgresql://postgres:${PASSWORD}@db.abc.supabase.co:5432/postgres`;
const KEY = "SENTINEL-sb_secret_77aa";
const URL_ = "https://abc.supabase.co";
const MIGS: Migration[] = [1, 2, 3].map((n) => ({ version: n, file: `000${n}_x.sql`, sql: `-- sql ${n}` }));

/** A fake Postgres: remembers the version, runs "-- sql N" as setting it to N, and can fail on one file. */
function fakePg(over: { start?: number | null; failOn?: number; recorded?: (n: number) => number; connectError?: string } = {}) {
  const queries: string[] = [];
  let version = over.start ?? null; // null = no weekpost_schema table
  let ended = false;
  const client: PgClient = {
    async connect() {
      if (over.connectError) throw Object.assign(new Error(over.connectError), { code: "ECONNREFUSED" });
    },
    async query(sql) {
      queries.push(sql);
      const m = /^-- sql (\d)/.exec(sql);
      if (m) {
        const n = Number(m[1]);
        if (over.failOn === n) throw Object.assign(new Error(`syntax error near ${CONN}`), { code: "42601" });
        version = over.recorded ? over.recorded(n) : n;
        return { rows: [] };
      }
      if (sql.includes("to_regclass")) return { rows: [{ t: version === null ? null : "weekpost_schema" }] };
      if (sql.includes("max(version)")) return { rows: [{ version }] };
      return { rows: [] };
    },
    async end() {
      ended = true;
    },
  };
  return { client, queries, ended: () => ended, version: () => version };
}

describe("migrations on disk", () => {
  it("reads the shipped files in order", () => {
    const all = readMigrations();
    expect(all.map((m) => m.version)).toEqual([1, 2, 3, 4]);
    expect(all[0]!.sql).toContain("weekpost_schema");
  });
  it("pendingAfter and printable", () => {
    expect(pendingAfter(MIGS, 1).map((m) => m.version)).toEqual([2, 3]);
    expect(printable(pendingAfter(MIGS, 2))).toBe("-- 0003_x.sql\n-- sql 3\n");
  });
});

describe("applyMigrations", () => {
  it("applies from zero, one file at a time, then reloads the REST schema", async () => {
    const pg = fakePg();
    const lines: string[] = [];
    expect(await applyMigrations(pg.client, MIGS, (l) => lines.push(l), CONN)).toBe(3);
    expect(pg.queries.filter((q) => q.startsWith("-- sql"))).toEqual(["-- sql 1", "-- sql 2", "-- sql 3"]);
    expect(pg.queries.at(-1)).toContain("reload schema");
    expect(pg.ended()).toBe(true);
  });

  it("applies only what is pending, and a second run changes nothing", async () => {
    const pg = fakePg({ start: 1 });
    expect(await applyMigrations(pg.client, MIGS, () => {}, CONN)).toBe(2);
    expect(await applyMigrations(pg.client, MIGS, () => {}, CONN)).toBe(0);
    expect(pg.queries.filter((q) => q.startsWith("-- sql"))).toEqual(["-- sql 2", "-- sql 3"]);
  });

  it("rolls back and stops at the failing file, keeping the earlier ones, with no connection string in the error", async () => {
    const pg = fakePg({ failOn: 2 });
    const err = await applyMigrations(pg.client, MIGS, () => {}, CONN).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("0002_x.sql failed and was rolled back");
    expect((err as Error).message).toContain("42601");
    expect((err as Error).message).not.toContain(PASSWORD);
    expect(pg.queries).toContain("rollback");
    expect(pg.queries).not.toContain("-- sql 3");
    expect(pg.version()).toBe(1);
    expect(pg.ended()).toBe(true);
  });

  it("fails when the recorded version does not match the file", async () => {
    const pg = fakePg({ recorded: () => 9 });
    await expect(applyMigrations(pg.client, MIGS, () => {}, CONN)).rejects.toThrow(/weekpost_schema says 9, expected 1/);
  });

  it("scrubs the password from a connection error", async () => {
    const pg = fakePg({ connectError: `connect to ${CONN} refused (password ${PASSWORD})` });
    const err = (await applyMigrations(pg.client, MIGS, () => {}, CONN).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("could not connect");
    expect(err.message).not.toContain(PASSWORD);
  });
});

function ioOf(over: { env?: Record<string, string>; print?: boolean; fetch?: typeof fetch; ask?: (l: string) => Promise<string> } = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const ctx = { supabase: { url: URL_, key: KEY }, bucket: "weekpost-media", fetch: over.fetch ?? (async () => new Response("[]", { status: 404 })) } as unknown as SetupContext;
  const io: ApplyIO = {
    out: { log: (l) => lines.push(l), error: (l) => lines.push(`ERR ${l}`) },
    confirm: async () => true,
    secret: async (n) => {
      asked.push(n);
      if (n === "DATABASE_URL") return over.env?.DATABASE_URL ?? (await over.ask!(n));
      return n === "WEEKPOST_SUPABASE_URL" ? URL_ : KEY;
    },
    context: () => ctx,
    options: { print: over.print },
  };
  return { io, lines, asked };
}

describe("migrateAction", () => {
  const step = { id: "db.migrate", title: "", commands: [] } as never;

  it("asks for the connection string, never takes it from the arguments, and applies", async () => {
    const pg = fakePg();
    const { io, asked } = ioOf({ env: { DATABASE_URL: CONN } });
    await migrateAction({ pg: () => pg.client, migrations: MIGS })(io, step);
    expect(asked).toEqual(["DATABASE_URL"]);
    expect(pg.version()).toBe(3);
  });

  it.each(["disable", "allow", "prefer"])("refuses sslmode=%s on a remote host, before connecting and without echoing the password", async (mode) => {
    let built = false;
    const { io } = ioOf({ env: { DATABASE_URL: `${CONN}?sslmode=${mode}` } });
    const err = (await migrateAction({ pg: () => ((built = true), fakePg().client), migrations: MIGS })(io, step).catch((e: Error) => e)) as Error;
    expect(err.message).toContain(`sslmode=${mode}`);
    expect(err.message).not.toContain(PASSWORD);
    expect(built).toBe(false);
  });

  it("refuses a string that is not a postgres URL, without echoing it", async () => {
    const { io } = ioOf({ env: { DATABASE_URL: `mysql://u:${PASSWORD}@h/db` } });
    const err = (await migrateAction({ pg: () => fakePg().client, migrations: MIGS })(io, step).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("postgres://");
    expect(err.message).not.toContain(PASSWORD);
  });

  it("--print prints the pending SQL and neither asks for the connection string nor connects", async () => {
    const f = (async () => new Response(JSON.stringify([{ version: 1 }]), { status: 200 })) as typeof fetch;
    const { io, lines, asked } = ioOf({ print: true, fetch: f });
    let connected = false;
    await migrateAction({ pg: () => ((connected = true), fakePg().client), migrations: MIGS })(io, step);
    expect(asked).toEqual([]);
    expect(connected).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("-- 0002_x.sql");
    expect(text).toContain("-- 0003_x.sql");
    expect(text).not.toContain("-- 0001_x.sql");
  });
});

describe("bucketAction", () => {
  const step = { id: "storage.bucket", title: "", commands: [] } as never;
  const stub = (answers: [number, unknown][]) => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      const [status, body] = answers.shift() ?? [200, {}];
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it("creates a private bucket and checks it", async () => {
    const s = stub([[200, { name: "weekpost-media" }], [200, { public: false }]]);
    await bucketAction(ioOf({ fetch: s.f }).io, step);
    expect(s.calls[0]).toMatchObject({ method: "POST", url: `${URL_}/storage/v1/bucket` });
    expect(JSON.parse(s.calls[0]!.body!)).toMatchObject({ public: false, id: "weekpost-media" });
  });

  it("is a no-op when the bucket exists (409) and private", async () => {
    const s = stub([[409, { message: "already exists" }], [200, { public: false }]]);
    await expect(bucketAction(ioOf({ fetch: s.f }).io, step)).resolves.toBeUndefined();
  });

  it("fails when the existing bucket is public", async () => {
    const s = stub([[409, { message: "already exists" }], [200, { public: true }]]);
    await expect(bucketAction(ioOf({ fetch: s.f }).io, step)).rejects.toThrow(/must be private/);
  });

  it("fails with a message that has no key when Supabase refuses", async () => {
    const s = stub([[401, { message: `bad key ${KEY}` }]]);
    const err = (await bucketAction(ioOf({ fetch: s.f }).io, step).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("401");
    expect(err.message).not.toContain(KEY);
  });
});

describe("through the apply loop", () => {
  it("a connection string typed at the prompt never appears in the output, even when the driver echoes it", async () => {
    const pg = fakePg({ failOn: 1 });
    const lines: string[] = [];
    const ctx = { supabase: { url: URL_, key: KEY }, accounts: [], previewLabel: "x", bucket: "b", project: "p", latestSchema: 3, env: {}, projectRoot: "/", localEnvFile: "/nope",
      run: async () => ({ status: 1, stdout: "", stderr: "" }), fetch: (async () => new Response("[]", { status: 404 })) as typeof fetch, hasChromium: async () => true } as unknown as SetupContext;
    const code = await runApply(ctx, { log: (l) => lines.push(l), error: (l) => lines.push(l) }, async () => true, {
      only: "db.migrate", env: {}, ask: async () => CONN, actions: { "db.migrate": migrateAction({ pg: () => pg.client, migrations: MIGS }) },
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).not.toContain(PASSWORD);
  });
});

describe("pgTls", () => {
  it("encrypts without verifying when the string has no sslmode or sslmode=require, and drops the sslmode so pg does not override it", () => {
    for (const q of ["", "?sslmode=require"]) {
      const t = pgTls(`${CONN}${q}`);
      expect(t.ssl).toEqual({ rejectUnauthorized: false });
      expect(t.verified).toBe(false);
      expect(t.connectionString).not.toContain("sslmode");
    }
  });

  it("passes verify-ca and verify-full through untouched so pg verifies the certificate (sslrootcert included)", () => {
    for (const mode of ["verify-ca", "verify-full"]) {
      const c = `${CONN}?sslmode=${mode}&sslrootcert=/tmp/prod-ca-2021.crt`;
      expect(pgTls(c)).toEqual({ connectionString: c, ssl: false, verified: true });
    }
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("lets %s go without TLS, even with sslmode=disable", (host) => {
    const c = `postgresql://postgres:x@${host}:54322/postgres?sslmode=disable`;
    expect(pgTls(c)).toEqual({ connectionString: c, ssl: false, verified: false });
  });

  it("refuses disable, allow and prefer on a remote host", () => {
    for (const m of ["disable", "allow", "prefer"]) expect(() => pgTls(`${CONN}?sslmode=${m}`)).toThrow(`sslmode=${m}`);
  });
});
