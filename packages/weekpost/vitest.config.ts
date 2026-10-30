import { defineConfig } from "vitest/config";

// Tests run in UTC so date logic is deterministic everywhere.
process.env.TZ = "UTC";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts", "worker/**/*.test.ts"],
    // The SQL suite needs Postgres: `npm run test:db`.
    exclude: ["src/queue/sql.test.ts", "src/setup/migrate.sql.test.ts", "node_modules/**"], env: { TZ: "UTC" } },
});
