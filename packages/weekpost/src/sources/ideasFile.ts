// Core adapter: a notes file in the user's repo, one idea per line: `- title — https://…`.
// The date of an idea is the date of the commit that last touched its line (git blame), so an idea jotted down
// last week belongs to last week's pull. A line that is not committed yet counts as new (now).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { SourceAdapter, SourceItem } from "./types.ts";

const LINE = /^\s*[-*]\s+(.+?)\s+(?:—|–|-)\s+(https:\/\/\S+)\s*$/u;

export type ParsedIdea = { line: number; title: string; url: string };

export function parseIdeas(text: string): ParsedIdea[] {
  const out: ParsedIdea[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = LINE.exec(raw);
    if (m) out.push({ line: i + 1, title: m[1]!.trim(), url: m[2]! });
  });
  return out;
}

/** Commit date of each line: line number -> ISO date. Empty when the file is not tracked by git. */
export function blameDates(file: string): Record<number, string> {
  let text: string;
  try {
    text = execFileSync("git", ["blame", "--line-porcelain", "--", file], { cwd: dirname(file), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return {};
  }
  const dates: Record<number, string> = {};
  let line = 0;
  let time = 0;
  let uncommitted = false;
  for (const row of text.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row);
    if (head) {
      line = Number(head[2]);
      uncommitted = /^0{40}$/.test(head[1]!);
    } else if (row.startsWith("committer-time ")) {
      time = Number(row.slice("committer-time ".length));
    } else if (row.startsWith("\t") && line && !uncommitted && time) {
      dates[line] = new Date(time * 1000).toISOString();
    }
  }
  return dates;
}

export type IdeasFileDeps = {
  lineDates?: (absoluteFile: string) => Record<number, string>;
  now?: () => Date;
};

export function ideasFile(opts: { path: string }, deps: IdeasFileDeps = {}): SourceAdapter {
  return {
    name: "ideasFile",
    async pull(q, ctx) {
      const root = resolve(ctx.projectDir);
      const file = resolve(root, opts.path);
      const inside = (a: string, b: string) => {
        const rel = relative(a, b);
        return !rel.startsWith("..") && !isAbsolute(rel);
      };
      if (!inside(root, file)) throw new Error(`${opts.path} must be inside the project`);
      // A link inside the project that points outside it is read as outside.
      try {
        if (!inside(realpathSync(root), realpathSync(file))) throw new Error(`${opts.path} must be inside the project`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // a missing file gets the clearer message below
      }
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        throw new Error(`cannot read ${opts.path}; create it with lines like "- an idea — https://example.com/page"`);
      }
      const dates = (deps.lineDates ?? blameDates)(file);
      const now = (deps.now ?? (() => new Date()))().toISOString();
      const from = Date.parse(q.from);
      const to = Date.parse(q.to);
      const items: SourceItem[] = [];
      for (const idea of parseIdeas(text)) {
        const publishedAt = new Date(dates[idea.line] ?? now).toISOString();
        const t = Date.parse(publishedAt);
        if (t < from || t >= to) continue;
        items.push({ id: createHash("sha256").update(idea.url).digest("hex").slice(0, 12), title: idea.title, url: idea.url, publishedAt });
        if (items.length >= q.limit) break;
      }
      return items;
    },
  };
}
