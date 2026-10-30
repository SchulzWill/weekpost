// Text of the pull request comments the CI workflows post. Pure functions: the workflows pass data in, the
// text comes out, and the tests pin the wording.
import type { Summary } from "../cli/enqueue.ts";

const MAX_LISTED = 10;
const MAX_ERROR_LINES = 20;

type Warning = { level: "error" | "warn"; where: string; message: string };
export type PreviewWeek = { week: string; spentUsd: number; budgetUsd: number; warnings: Warning[] };

/** One line of plain text: no newlines, no backticks, and @mentions defused so a comment never pings anyone. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").replace(/`/g, "'").replace(/@/g, "@​").trim();
const code = (s: string) => `\`${oneLine(s)}\``;
const usd = (n: number) => `US$${n.toFixed(2)}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export type PreviewCommentInput = {
  weeks: PreviewWeek[];
  /** Weeks that were asked for but have no usable preview. */
  missing: string[];
  sha: string;
  runUrl: string;
  pr: number;
  generationFailed: boolean;
};

export function previewComment(i: PreviewCommentInput): string {
  const names = [...i.weeks.map((w) => w.week), ...i.missing];
  const lines = [`**Media preview** (${names.map(code).join(", ")}) for commit ${code(i.sha.slice(0, 7))}`, ""];
  if (i.generationFailed) {
    lines.push(`Generation failed${i.missing.length ? ` for ${i.missing.map(code).join(", ")}` : ""}: the posts without a preview are missing below. See [the run](${i.runUrl}) for the error.`, "");
  }
  for (const w of i.weeks) {
    lines.push(`- ${code(w.week)}: cost ${usd(w.spentUsd)} of ${usd(w.budgetUsd)} (weekly cap)`);
    const listed = w.warnings.slice(0, MAX_LISTED);
    for (const x of listed) lines.push(`  - ${x.level === "error" ? "error" : "warning"} ${code(x.where)}: ${oneLine(x.message)}`);
    if (w.warnings.length > MAX_LISTED) lines.push(`  - ${w.warnings.length - MAX_LISTED} more in the preview page`);
  }
  lines.push("", `Open it from [the run](${i.runUrl}) (artifact \`weekpost-preview\`, kept for 30 days) or run ${code(`npx weekpost preview ${i.pr}`)}.`);
  lines.push("", "Merging queues exactly this media. Pushing a new commit generates it again.");
  return lines.join("\n");
}

/** Skipped posts that need a sentence of their own, in the order the comment shows them. */
const SKIP_KINDS: { kind: NonNullable<Summary["skipped"][number]["kind"]>; title: string }[] = [
  { kind: "operator", title: "Left canceled, because the operator canceled them (`weekpost restore` undoes it):" },
  { kind: "past", title: "Not queued, because their publish time has already passed (they would go out at once). Move them to a future date, or run the workflow again with `allow_past`:" },
  { kind: "newer", title: "Left as they were, because a newer merge queued them (this run read older content; nothing to do):" },
];

export type EnqueueCommentInput =
  | { status: "ok"; summary: Summary; runUrl: string }
  | { status: "no-preview"; label: string; runUrl: string }
  | { status: "failed"; errors: string[]; runUrl: string };

export function enqueueComment(i: EnqueueCommentInput): string {
  if (i.status === "ok") {
    const { scheduled, skipped } = i.summary;
    const canceled = i.summary.canceled ?? [];
    const lines = [`**Scheduled ${plural(scheduled, "post")}, ${skipped.length} skipped${canceled.length ? `, ${canceled.length} canceled` : ""}.** [Run](${i.runUrl})`];
    const revived = i.summary.revived ?? [];
    if (revived.length) {
      lines.push("", "Brought back (canceled earlier when they left the merged YAML, and now in it again):");
      for (const k of revived) lines.push(`- ${code(k)}`);
    }
    if (canceled.length) {
      lines.push("", "Canceled posts (no longer in the merged YAML):");
      for (const c of canceled) lines.push(`- ${code(c.key)}: ${oneLine(c.reason)}`);
    }
    const plain = skipped.filter((s) => !s.kind);
    if (plain.length) {
      lines.push("", "Skipped posts:");
      for (const s of plain) lines.push(`- ${code(s.key)}: ${oneLine(s.reason)}`);
    }
    for (const { kind, title } of SKIP_KINDS) {
      const group = skipped.filter((s) => s.kind === kind);
      if (!group.length) continue;
      lines.push("", title);
      for (const s of group) lines.push(`- ${code(s.key)}: ${oneLine(s.reason)}`);
    }
    return lines.join("\n");
  }
  if (i.status === "no-preview") {
    return [
      "**Nothing was scheduled.** There is no approved preview for the merged commit (it did not run, failed, or the artifact expired).",
      "",
      `To fix it: re-apply the \`${oneLine(i.label)}\` label on this pull request and wait for the preview comment, then run the enqueue workflow again with this pull request number. Re-applying the label generates new media and needs a new review. [Run](${i.runUrl})`,
    ].join("\n");
  }
  const errors = i.errors.slice(0, MAX_ERROR_LINES).map((e) => e.replace(/```/g, "'''").replace(/@/g, "@​"));
  return [
    "**Nothing was scheduled.** The approved preview does not match what was merged, or the queue could not be written. Some rows may have been written; running the enqueue again converges (it skips what is already queued and finishes the rest).",
    "",
    "```",
    ...(errors.length ? errors : ["(no error output; see the run)"]),
    "```",
    "",
    `Fix the cause and run the enqueue workflow again with this pull request number. [Run](${i.runUrl})`,
  ].join("\n");
}
