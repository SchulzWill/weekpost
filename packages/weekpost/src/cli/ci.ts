// weekpost ci <pack|comment>: helpers the CI workflows call, so the YAML stays thin.
//   ci pack <weeks-file> <dest> [--project=<dir>]                 build the preview artifact from out/
//   ci comment preview <artifact-dir> <weeks-file> --pr=<n> --sha=<sha> --run-url=<url> [--generation-failed] [--out=<file>]
//   ci comment enqueue --status=ok|no-preview|failed --run-url=<url> [--summary=<file>] [--log=<file>] [--label=<name>] [--out=<file>]
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import { manifestSchema } from "../render/manifest.ts";
import { enqueueComment, previewComment, type PreviewWeek } from "../ci/comment.ts";
import { packArtifact } from "../ci/pack.ts";
import { projectPaths, type Out } from "./check.ts";
import type { Summary } from "./enqueue.ts";

const USAGE = `usage: weekpost ci pack <weeks-file> <dest> [--project=<dir>]
       weekpost ci comment preview <artifact-dir> <weeks-file> --pr=<n> --sha=<sha> --run-url=<url> [--generation-failed] [--out=<file>]
       weekpost ci comment enqueue --status=ok|no-preview|failed --run-url=<url> [--summary=<file>] [--log=<file>] [--label=<name>] [--out=<file>]`;
const DEFAULT_LABEL = "media-ok";

const readLines = (file: string) => readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);

// Returns the exit code.
export async function runCi(args: string[], out: Out = console, cwd = process.cwd()): Promise<number> {
  const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const positional = args.filter((a) => !a.startsWith("--"));
  const [sub, ...rest] = positional;
  const emit = (body: string) => {
    const file = opt("out");
    if (file) writeFileSync(resolve(cwd, file), `${body}\n`);
    else out.log(body);
    return 0;
  };
  try {
    if (sub === "pack" && rest.length === 2) {
      const { projectRoot } = projectPaths(args, cwd);
      const weeks = readLines(resolve(cwd, rest[0]));
      const r = packArtifact(join(projectRoot, "out"), weeks, resolve(cwd, rest[1]));
      for (const p of r.packed) out.log(`packed ${p.week}`);
      for (const w of r.missing) out.log(`no preview for ${w}: it has no valid manifest.json`);
      return 0;
    }
    if (sub === "comment" && rest[0] === "preview" && rest.length === 3) {
      const [, artifact, weeksFile] = rest;
      const pr = opt("pr"), sha = opt("sha"), runUrl = opt("run-url");
      if (!pr || !/^\d+$/.test(pr) || !sha || !runUrl) return fail(out, "ci comment preview needs --pr=<number>, --sha and --run-url");
      const weeks: PreviewWeek[] = [];
      const missing: string[] = [];
      for (const week of readLines(resolve(cwd, weeksFile))) {
        try {
          const m = manifestSchema.parse(JSON.parse(readFileSync(resolve(cwd, artifact, week, "manifest.json"), "utf8")));
          weeks.push({ week, spentUsd: m.spentUsd, budgetUsd: m.budgetUsd, warnings: m.warnings });
        } catch {
          missing.push(week);
        }
      }
      return emit(previewComment({ weeks, missing, sha, runUrl, pr: Number(pr), generationFailed: args.includes("--generation-failed") }));
    }
    if (sub === "comment" && rest[0] === "enqueue" && rest.length === 1) {
      const status = opt("status"), runUrl = opt("run-url");
      if (!runUrl || (status !== "ok" && status !== "no-preview" && status !== "failed")) return fail(out, "ci comment enqueue needs --status=ok|no-preview|failed and --run-url");
      if (status === "ok") {
        const file = opt("summary");
        if (!file) return fail(out, "ci comment enqueue --status=ok needs --summary=<file>");
        return emit(enqueueComment({ status, summary: JSON.parse(readFileSync(resolve(cwd, file), "utf8")) as Summary, runUrl }));
      }
      if (status === "no-preview") return emit(enqueueComment({ status, label: opt("label") ?? (await labelFromConfig(args, cwd)), runUrl }));
      let errors: string[] = [];
      const log = opt("log");
      if (log) {
        try {
          errors = readLines(resolve(cwd, log)).filter((l) => /^(error|nothing)/i.test(l));
        } catch {
          // No log: the comment points at the run.
        }
      }
      return emit(enqueueComment({ status, errors, runUrl }));
    }
  } catch (e) {
    return fail(out, `error: ${(e as Error).message}`);
  }
  out.error(USAGE);
  return 2;
}

function fail(out: Out, message: string): number {
  out.error(message);
  return 1;
}

async function labelFromConfig(args: string[], cwd: string): Promise<string> {
  try {
    return (await loadConfig(projectPaths(args, cwd).projectRoot)).config.ci.previewLabel;
  } catch {
    return DEFAULT_LABEL;
  }
}
