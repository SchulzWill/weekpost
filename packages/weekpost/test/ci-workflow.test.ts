// Rules the repository's own CI must keep: it runs on pull requests from forks once the repository is public.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const path = join(import.meta.dirname, "../../../.github/workflows/ci.yml");
const raw = readFileSync(path, "utf8");
type Job = { name?: string; needs?: unknown; if?: string; strategy?: { "fail-fast"?: boolean; matrix?: { node?: number[] } }; permissions?: unknown; steps: { uses?: string; run?: string }[] };
const w = parse(raw) as { on: Record<string, unknown>; permissions?: unknown; concurrency?: { group?: string; "cancel-in-progress"?: boolean }; jobs: Record<string, Job> };

describe("ci workflow", () => {
  it("runs on pull requests and pushes to main, and never on pull_request_target", () => {
    expect(Object.keys(w.on).sort()).toEqual(["pull_request", "push"]);
    expect((w.on.push as { branches: string[] }).branches).toEqual(["main"]);
    expect(raw).not.toMatch(/^\s*[^#\n]*pull_request_target/m);
  });

  it("pins every action to a 40-character SHA with a version comment", () => {
    const uses = raw.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l).toMatch(/uses: [\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it("has read-only contents permissions and no job widens them", () => {
    expect(w.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(w.jobs)) expect(job.permissions, name).toBeUndefined();
  });

  it("uses no secrets and keeps ${{ }} expressions out of shell scripts", () => {
    expect(raw).not.toContain("secrets.");
    for (const job of Object.values(w.jobs)) for (const s of job.steps) if (s.run) expect(s.run).not.toContain("${{");
  });

  it("cancels the previous run of the same ref", () => {
    expect(w.concurrency).toEqual({ group: "ci-${{ github.ref }}", "cancel-in-progress": true });
  });

  it("has the verify-node, verify, test-db and actionlint jobs", () => {
    expect(Object.keys(w.jobs).sort()).toEqual(["actionlint", "test-db", "verify", "verify-node"]);
    expect(w.jobs["verify-node"].steps.some((s) => s.run === "npm run verify")).toBe(true);
    expect(w.jobs["test-db"].steps.some((s) => s.run === "npm run test:db")).toBe(true);
  });

  it("runs verify on Node 22, 24 and 26 without cancelling siblings", () => {
    const job = w.jobs["verify-node"];
    expect(job.strategy?.matrix?.node).toEqual([22, 24, 26]);
    expect(job.strategy?.["fail-fast"]).toBe(false);
    expect(job.name).toBe("verify (node ${{ matrix.node }})");
  });

  it("keeps a single aggregate job named exactly verify (the required status check) that fails unless the whole matrix succeeded", () => {
    const job = w.jobs.verify;
    expect(job.name).toBe("verify");
    expect(job.needs).toBe("verify-node");
    expect(job.if).toBe("always()");
    expect(job.steps.some((s) => s.run?.includes('test "$MATRIX_RESULT" = "success"'))).toBe(true);
    expect(raw).toContain("MATRIX_RESULT: ${{ needs.verify-node.result }}");
  });
});
