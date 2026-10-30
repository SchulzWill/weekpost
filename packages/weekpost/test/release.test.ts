// The release script: version rules, changelog stamping, and a full run in a throwaway git repo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { compareVersions, parseVersion, release, releaseNotes, stampChangelog, validateUnreleased } from "../scripts/release.mjs";
import { main, packageVersion } from "../src/cli/main.ts";

const CHANGELOG = `# Changelog

## Unreleased

### You need to do

- Run the new migration.

### Improvements

- Faster check.

## 0.1.0 - 2026-01-01

### You need to do

(none)

### Improvements

- First release.
`;

describe("versions", () => {
  it("accepts only 0.x.y", () => {
    expect(parseVersion("0.2.10")).toEqual([0, 2, 10]);
    for (const bad of ["1.0.0", "0.1", "0.1.0-rc1", "v0.1.0", "0.01.0"]) expect(() => parseVersion(bad), bad).toThrow();
  });
  it("compares numerically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.2", "0.2.0")).toBe(-1);
  });
});

describe("changelog", () => {
  it("stamps Unreleased and opens a fresh one", () => {
    const out = stampChangelog(CHANGELOG, "0.2.0", "2026-02-02");
    expect(out).toContain("## 0.2.0 - 2026-02-02\n\n### You need to do\n\n- Run the new migration.");
    expect(out.indexOf("## Unreleased")).toBeLessThan(out.indexOf("## 0.2.0"));
    expect(out).toContain("## 0.1.0 - 2026-01-01");
    expect(() => validateUnreleased(out)).toThrow(/no entries/);
  });
  it("refuses a missing subsection, empty entries and a repeated version", () => {
    expect(() => validateUnreleased("## Unreleased\n\n### Improvements\n\n- x\n")).toThrow(/You need to do/);
    expect(() => validateUnreleased("# Changelog\n")).toThrow(/Unreleased/);
    expect(() => stampChangelog(CHANGELOG, "0.1.0", "2026-02-02")).toThrow(/already/);
  });
  it("extracts the notes of one version", () => {
    const notes = releaseNotes(stampChangelog(CHANGELOG, "0.2.0", "2026-02-02"), "0.2.0");
    expect(notes).toContain("- Faster check.");
    expect(notes).not.toContain("First release");
  });
});

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "weekpost-release-"));
  const sh = (...a: string[]) => execFileSync("git", a, { cwd: root });
  mkdirSync(join(root, "packages/weekpost"), { recursive: true });
  writeFileSync(join(root, "packages/weekpost/package.json"), JSON.stringify({ name: "weekpost-fixture", version: "0.1.0" }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "packages/weekpost": { version: "0.1.0" } } }));
  writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);
  sh("init", "-q");
  sh("add", ".");
  sh("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  return root;
}

describe("release", () => {
  it("dry run writes nothing", () => {
    const root = fixtureRepo();
    const r = release({ root, version: "0.2.0", dryRun: true });
    expect(r.tarball).toBeNull();
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
  });
  it("sets the version, stamps the changelog and packs a tarball named after the version", () => {
    const root = fixtureRepo();
    const r = release({ root, version: "0.2.0", date: "2026-02-02", run: false });
    expect(r.tarball).toMatch(/weekpost-fixture-0\.2\.0\.tgz$/);
    expect(JSON.parse(readFileSync(join(root, "packages/weekpost/package.json"), "utf8")).version).toBe("0.2.0");
    expect(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages["packages/weekpost"].version).toBe("0.2.0");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain("## 0.2.0 - 2026-02-02");
    expect(r.steps.join("\n")).toContain("git tag -a v0.2.0");
    expect(r.steps.join("\n")).not.toContain("--generate");
  }, 60_000);
  it("refuses an older version, a dirty tree and an existing tag", () => {
    const root = fixtureRepo();
    expect(() => release({ root, version: "0.0.9", run: false })).toThrow(/older/);
    execFileSync("git", ["tag", "v0.3.0"], { cwd: root });
    expect(() => release({ root, version: "0.3.0", run: false })).toThrow(/already exists/);
    writeFileSync(join(root, "stray.txt"), "x");
    expect(() => release({ root, version: "0.4.0", run: false })).toThrow(/not clean/);
  });
});

describe("weekpost --version", () => {
  it("prints the version in package.json", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m: string) => void lines.push(m);
    try {
      expect(await main(["--version"])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(lines).toEqual([packageVersion()]);
    expect(packageVersion()).toMatch(/^0\.\d+\.\d+$/);
  });
});
