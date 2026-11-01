// Rules the workflow templates must keep (they run with the user's secrets): pinned actions, minimal
// permissions, no pull_request_target, secrets only where needed, no expressions inside shell scripts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseConfig } from "../src/config/index.ts";
import template from "../template/weekpost.config.ts";

const dir = join(import.meta.dirname, "../template/.github");
const workflowsDir = join(dir, "workflows");
const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml")).sort();
const raw = (f: string) => readFileSync(join(workflowsDir, f), "utf8");

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { permissions?: Record<string, string>; environment?: string; steps: Step[]; if?: string };
type Workflow = { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> };
const load = (f: string) => parse(raw(f)) as Workflow;
const steps = (w: Workflow) => Object.entries(w.jobs).flatMap(([job, j]) => j.steps.map((s) => ({ job, ...s })));
const secretsIn = (s: Step): string[] => JSON.stringify({ env: s.env, with: s.with }).match(/secrets\.[A-Z_]+/g) ?? [];

describe("workflow templates", () => {
  it("ships the four workflows and the dependabot config", () => {
    expect(files).toEqual(["weekpost-check.yml", "weekpost-enqueue.yml", "weekpost-metrics.yml", "weekpost-preview.yml"]);
    expect(parse(readFileSync(join(dir, "dependabot.yml"), "utf8")).updates[0]["package-ecosystem"]).toBe("github-actions");
  });

  it.each(files)("%s never uses pull_request_target", (f) => {
    expect(Object.keys(load(f).on)).not.toContain("pull_request_target");
    expect(raw(f)).not.toMatch(/^\s*[^#\n]*pull_request_target/m);
  });

  it.each(files)("%s pins every action to a 40-character SHA with a version comment", (f) => {
    const uses = raw(f).split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l).toMatch(/uses: [\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it.each(files)("%s declares empty top-level permissions and explicit permissions on every job", (f) => {
    const w = load(f);
    expect(w.permissions).toEqual({});
    for (const [name, job] of Object.entries(w.jobs)) expect(job.permissions, `${f}:${name}`).toBeTruthy();
  });

  it.each(files)("%s grants no write permission beyond pull-requests (issues for the metrics)", (f) => {
    for (const job of Object.values(load(f).jobs)) {
      for (const [scope, level] of Object.entries(job.permissions!)) {
        if (level === "write") expect(scope).toBe(f === "weekpost-metrics.yml" ? "issues" : "pull-requests");
      }
    }
  });

  it.each(files)("%s keeps ${{ }} expressions out of shell scripts", (f) => {
    for (const s of steps(load(f))) if (s.run) expect(s.run, `${f}: ${s.name}`).not.toContain("${{");
  });

  it("the check workflow uses no secrets", () => {
    expect(raw("weekpost-check.yml")).not.toContain("secrets.");
  });

  it("OPENROUTER_API_KEY is used only by the generate step of the preview", () => {
    for (const f of files) {
      for (const s of steps(load(f))) {
        const has = secretsIn(s).includes("secrets.OPENROUTER_API_KEY");
        expect(has, `${f}: ${s.name}`).toBe(f === "weekpost-preview.yml" && s.name === "generate");
      }
    }
  });

  it("the database secrets are used only by the write step of the enqueue, and never by a pull request workflow", () => {
    for (const f of files) {
      for (const s of steps(load(f))) {
        const has = secretsIn(s).some((x) => x.startsWith("secrets.WEEKPOST_SUPABASE_"));
        const writers = [["weekpost-enqueue.yml", "upload the media and schedule"], ["weekpost-metrics.yml", "collect, store and report the metrics"]];
        expect(has, `${f}: ${s.name}`).toBe(writers.some(([wf, name]) => f === wf && s.name === name));
      }
    }
    expect(Object.keys(load("weekpost-enqueue.yml").on).sort()).toEqual(["push", "workflow_dispatch"]);
  });

  it("the enqueue runs the dry run before the write, in the weekpost environment, on main only", () => {
    const w = load("weekpost-enqueue.yml");
    const names = steps(w).map((s) => s.name);
    expect(names.indexOf("check the preview against the merged content")).toBeGreaterThan(-1);
    expect(names.indexOf("check the preview against the merged content")).toBeLessThan(names.indexOf("upload the media and schedule"));
    expect(w.jobs.enqueue.environment).toBe("weekpost");
    expect((w.on.push as { branches: string[] }).branches).toEqual(["main"]);
    const dry = steps(w).find((s) => s.name === "check the preview against the merged content")!;
    expect(dry.run).toContain("--dry-run");
    const write = steps(w).find((s) => s.name === "upload the media and schedule")!;
    expect(write.run).toContain("--summary=");
    expect(write.run).not.toContain("--dry-run");
  });

  it("the enqueue checks out the whole history and tells the CLI which commit it reads", () => {
    // The CLI asks git whether the commit that queued a row is an ancestor of this one; a shallow clone cannot answer.
    const w = load("weekpost-enqueue.yml");
    const checkout = steps(w).find((s) => s.uses?.startsWith("actions/checkout"))!;
    expect(checkout.with?.["fetch-depth"]).toBe(0);
    for (const name of ["check the preview against the merged content", "upload the media and schedule"]) {
      const step = steps(w).find((s) => s.name === name)!;
      expect(step.run, name).toContain('--commit="$SHA"');
      expect(step.env?.SHA, name).toBe("${{ github.sha }}");
    }
  });

  it("the manual dispatch has an allow_past input (off by default) that reaches the write step only through the environment", () => {
    const w = load("weekpost-enqueue.yml");
    const input = (w.on.workflow_dispatch as { inputs: Record<string, { type?: string; default?: unknown }> }).inputs.allow_past;
    expect(input).toMatchObject({ type: "boolean", default: false });
    const write = steps(w).find((s) => s.name === "upload the media and schedule")!;
    expect(write.env?.ALLOW_PAST).toBe("${{ inputs.allow_past }}");
    expect(write.run).toContain("--allow-past");
    const dry = steps(w).find((s) => s.name === "check the preview against the merged content")!;
    expect(dry.run).not.toContain("--allow-past");
  });

  it("the enqueue serializes per pull request and never cancels a run", () => {
    const w = load("weekpost-enqueue.yml") as Workflow & { concurrency?: { group?: string; "cancel-in-progress"?: boolean } };
    // A single group would keep one pending run and silently cancel the others when merges come in a row.
    expect(w.concurrency?.group).toBe("weekpost-enqueue-${{ github.event.pull_request.number || github.run_id }}");
    expect(w.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("the enqueue job only runs from main, on push and on a manual dispatch", () => {
    const job = load("weekpost-enqueue.yml").jobs.enqueue;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
  });

  it("the enqueue comment comes from the --summary file", () => {
    const comment = steps(load("weekpost-enqueue.yml")).find((s) => s.name === "comment on the pull request")!;
    expect(comment.run).toContain("--summary=");
  });

  it("the metrics workflow runs weekly and by hand, from main, in the weekpost environment, with minimal permissions", () => {
    const w = load("weekpost-metrics.yml");
    expect(Object.keys(w.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const cron = (w.on.schedule as { cron: string }[]).map((c) => c.cron);
    expect(cron).toHaveLength(1);
    expect(cron[0]).toMatch(/^\d+ \d+ \* \* [0-6]$/); // fixed minute and hour, one weekday: once a week
    const job = w.jobs.metrics;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("weekpost");
    expect(job.permissions).toEqual({ contents: "read", issues: "write" });
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout"))!;
    expect(checkout.with?.["persist-credentials"]).toBe(false);
  });

  it("the metrics step runs `metrics --write --issue` with the database secrets and the GitHub token", () => {
    const step = steps(load("weekpost-metrics.yml")).find((s) => s.name === "collect, store and report the metrics")!;
    expect(step.run).toContain("weekpost metrics --write --issue");
    expect(step.env).toMatchObject({
      WEEKPOST_SUPABASE_URL: "${{ secrets.WEEKPOST_SUPABASE_URL }}",
      WEEKPOST_SUPABASE_KEY: "${{ secrets.WEEKPOST_SUPABASE_KEY }}",
      GITHUB_TOKEN: "${{ github.token }}",
      GITHUB_REPOSITORY: "${{ github.repository }}",
    });
  });

  it("the preview only runs for same-repository branches and labels it with the configured label", () => {
    const gen = load("weekpost-preview.yml").jobs.generate;
    expect(gen.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    const label = parseConfig(template).config.ci.previewLabel;
    expect(gen.if).toContain(`'${label}'`);
    expect(raw("weekpost-preview.yml").match(/'media-ok'/g)).toHaveLength(2);
  });

  it("the job that writes comments has no checkout", () => {
    const w = load("weekpost-preview.yml");
    for (const name of ["comment", "pages"]) {
      expect(w.jobs[name].steps.some((s) => s.uses?.startsWith("actions/checkout")), name).toBe(false);
    }
  });

  it("no job that checks out code has write permissions", () => {
    for (const f of files) {
      for (const [name, job] of Object.entries(load(f).jobs)) {
        if (job.steps.some((s) => s.uses?.startsWith("actions/checkout")) && f !== "weekpost-enqueue.yml" && f !== "weekpost-metrics.yml") {
          expect(Object.values(job.permissions!), `${f}:${name}`).not.toContain("write");
        }
      }
    }
  });
});
