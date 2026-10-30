// Runs before `npm pack` / `npm publish`: the tarball must carry the template that `weekpost init` copies.
// The template lives in the package (template/), so there is nothing to copy; this fails the pack if a piece is missing.
import { existsSync } from "node:fs";

const base = new URL("../template/", import.meta.url);
const required = [
  "weekpost.config.ts",
  "assets/README.md",
  "content/.gitkeep",
  "gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "BRIEF.md",
  "skills/open-week/SKILL.md",
  "skills/queue-status/SKILL.md",
  ".claude/settings.json",
  ".codex/config.toml",
  ".codex/rules/weekpost.rules",
  "assets/logo.svg",
  "assets/fonts/OFL.txt",
  "assets/fonts/inter-400.woff2",
  "assets/fonts/inter-800.woff2",
  "worker/index.ts",
  "worker/wrangler.toml",
  ".github/dependabot.yml",
  ".github/workflows/weekpost-check.yml",
  ".github/workflows/weekpost-enqueue.yml",
  ".github/workflows/weekpost-preview.yml",
];
const missing = required.filter((f) => !existsSync(new URL(f, base)));
if (missing.length) {
  console.error(`prepack: the template is incomplete, missing: ${missing.join(", ")}`);
  process.exit(1);
}
