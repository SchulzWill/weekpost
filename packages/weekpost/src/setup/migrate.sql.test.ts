// Runs the real migrations through applyMigrations on a real Postgres (not part of `npm test`; see sql.test.ts for
// how to start a throw-away server). Applies from zero, then again without changing anything.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, readMigrations, type PgClient } from "./migrate.ts";

const URL_VAR = process.env.WEEKPOST_TEST_DATABASE_URL;
const NAME = `wp_test_migrate_${process.pid}`;
let admin: Client;
let url: string;

beforeAll(async () => {
  if (!URL_VAR) throw new Error("WEEKPOST_TEST_DATABASE_URL is not set (see src/queue/sql.test.ts)");
  admin = new Client({ connectionString: URL_VAR });
  await admin.connect();
  await admin.query(`drop database if exists ${NAME} with (force)`);
  await admin.query(`create database ${NAME}`);
  const u = new URL(URL_VAR);
  u.pathname = `/${NAME}`;
  url = u.toString();
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`drop database if exists ${NAME} with (force)`);
  await admin.end();
});

describe("applyMigrations on a real Postgres", () => {
  it("applies every shipped migration from zero, records the last version, and a second run changes nothing", async () => {
    const all = readMigrations();
    const run = () => applyMigrations(new Client({ connectionString: url }) as unknown as PgClient, all, () => {}, url);
    expect(await run()).toBe(all.length);

    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      const { rows } = await c.query("select version from public.weekpost_schema");
      expect(rows).toEqual([{ version: all.at(-1)!.version }]);
      expect(await run()).toBe(0);
      expect((await c.query("select version from public.weekpost_schema")).rows).toEqual(rows);
    } finally {
      await c.end();
    }
  });
});
