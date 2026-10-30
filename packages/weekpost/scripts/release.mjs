// Cuts a release locally: `node packages/weekpost/scripts/release.mjs <x.y.z> [--tag] [--dry-run]`.
// It never publishes: no push, no GitHub release. It prints the commands the owner runs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const VERSION_RE = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const SECTIONS = ["You need to do", "Improvements"];

export function parseVersion(v) {
  if (!VERSION_RE.test(v)) throw new Error(`"${v}" is not a 0.x.y version`);
  return v.split(".").map(Number);
}

export function compareVersions(a, b) {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// Text of a "## <heading>" section of the changelog, up to the next "## " heading.
function section(changelog, heading) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l === `## ${heading}` || l.startsWith(`## ${heading} `));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

// The Unreleased section must hold both subsections, and at least one of them must have a bullet.
export function validateUnreleased(changelog) {
  const body = section(changelog, "Unreleased");
  if (body === null) throw new Error('CHANGELOG.md has no "## Unreleased" section');
  for (const s of SECTIONS) {
    if (!new RegExp(`^### ${s}$`, "m").test(body)) throw new Error(`CHANGELOG.md: "## Unreleased" lacks "### ${s}"`);
  }
  if (!/^- \S/m.test(body)) throw new Error('CHANGELOG.md: "## Unreleased" has no entries');
}

// Turns "## Unreleased" into "## <version> - <date>" and opens a fresh, empty Unreleased above it.
export function stampChangelog(changelog, version, date) {
  validateUnreleased(changelog);
  if (section(changelog, version) !== null) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const fresh = ["## Unreleased", "", ...SECTIONS.flatMap((s) => [`### ${s}`, "", "(none yet)", ""])].join("\n");
  return changelog.replace(/^## Unreleased$/m, `${fresh}\n## ${version} - ${date}`);
}

// The body of the "## <version> - <date>" section, for the release page.
export function releaseNotes(changelog, version) {
  return (section(changelog, version) ?? "").trim();
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function release({ root, version, tag = false, dryRun = false, date = new Date().toISOString().slice(0, 10), run = true }) {
  const pkgPath = join(root, "packages/weekpost/package.json");
  const clPath = join(root, "CHANGELOG.md");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  parseVersion(version);
  if (compareVersions(version, pkg.version) < 0) throw new Error(`${version} is older than the current ${pkg.version}`);
  if (git(root, "status", "--porcelain")) throw new Error("the working tree is not clean: commit or stash first");
  if (git(root, "tag", "--list", `v${version}`)) throw new Error(`tag v${version} already exists`);
  const stamped = stampChangelog(readFileSync(clPath, "utf8"), version, date);
  if (dryRun) return { version, tarball: null, steps: [`would write CHANGELOG.md and package.json for ${version}`] };
  writeFileSync(clPath, stamped);
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  const lockPath = join(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.packages?.["packages/weekpost"]) {
    lock.packages["packages/weekpost"].version = version;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
  if (run) execFileSync("npm", ["run", "verify"], { cwd: root, stdio: "inherit", env: { ...process.env, TZ: "UTC" } });
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", dist], { cwd: join(root, "packages/weekpost"), encoding: "utf8" });
  const tarball = join(dist, JSON.parse(out)[0].filename);
  if (!existsSync(tarball)) throw new Error("npm pack did not produce the tarball");
  const notes = join(dist, `release-notes-${version}.md`);
  writeFileSync(notes, `${releaseNotes(stamped, version)}\n`);
  const steps = [
    `git add CHANGELOG.md packages/weekpost/package.json package-lock.json && git commit -m "Release ${version}"`,
    ...(tag ? [] : [`git tag -a v${version} -m "weekpost ${version}"`]),
    `git push origin main v${version}`,
    `gh release create v${version} ${tarball} --title "weekpost ${version}" --notes-file ${notes}`,
  ];
  return { version, tarball, steps };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith("--"));
  if (!version) {
    console.error("usage: node packages/weekpost/scripts/release.mjs <0.x.y> [--tag] [--dry-run]\n  --tag      also create the local tag v<version> (nothing is pushed)\n  --dry-run  only check the changelog, the tree and the tags");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    const tag = args.includes("--tag");
    const r = release({ root, version, tag, dryRun: args.includes("--dry-run") });
    if (tag && r.tarball) git(root, "tag", "-a", `v${version}`, "-m", `weekpost ${version}`);
    console.log(r.tarball ? `tarball: ${r.tarball}` : "dry run: nothing written");
    console.log(`\nnothing was published. To publish, run:\n${r.steps.map((s) => `  ${s}`).join("\n")}`);
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exit(1);
  }
}
