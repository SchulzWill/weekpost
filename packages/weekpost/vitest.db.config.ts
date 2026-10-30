import { defineConfig } from "vitest/config";

// SQL suite: needs a real Postgres (see src/queue/sql.test.ts). Run with `npm run test:db`.
export default defineConfig({
  test: { include: ["src/queue/sql.test.ts", "src/setup/migrate.sql.test.ts"], env: { TZ: "UTC" }, testTimeout: 20_000, hookTimeout: 30_000 },
});
