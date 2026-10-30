// What `npm pack` would ship: the template (init copies it), the migrations and the Worker.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("npm pack", () => {
  it("includes template/**, migrations/** and worker/**", () => {
    const json = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    const files = (JSON.parse(json) as { files: { path: string }[] }[])[0].files.map((f) => f.path);
    const has = (p: string) => expect(files, p).toContain(p);
    for (const p of [
      "template/weekpost.config.ts",
      "template/assets/README.md",
      "template/content/.gitkeep",
      "template/worker/index.ts",
      "template/worker/wrangler.toml",
      "template/.github/dependabot.yml",
      "template/.github/workflows/weekpost-check.yml",
      "template/.github/workflows/weekpost-enqueue.yml",
      "template/.github/workflows/weekpost-preview.yml",
      "migrations/0001_queue.sql",
      "worker/index.ts",
      "bin/weekpost.js",
    ]) has(p);
  }, 60_000);
});
