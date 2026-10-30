import { describe, expect, it } from "vitest";
import { enqueueComment, previewComment } from "./comment.ts";

describe("enqueueComment", () => {
  it("says how many posts were scheduled and lists the skipped ones with the reason", () => {
    const body = enqueueComment({
      status: "ok",
      summary: { scheduled: 3, updated: 1, skipped: [{ key: "2026-11-02-tip/en", reason: "already published" }], canceled: [] },
      runUrl: "https://github.com/o/r/actions/runs/1",
    });
    expect(body).toContain("Scheduled 3 posts, 1 skipped");
    expect(body).toContain("`2026-11-02-tip/en`: already published");
    expect(body).toContain("https://github.com/o/r/actions/runs/1");
  });

  it("explains the posts a newer merge queued in a group of their own", () => {
    const body = enqueueComment({
      status: "ok",
      summary: { scheduled: 0, updated: 0, skipped: [{ key: "2026-11-06-b/en", kind: "newer", reason: "queued by a newer commit (abc1234), this run reads 1234567; left as it is" }], canceled: [] },
      runUrl: "u",
    });
    expect(body).toContain("because a newer merge queued them");
    expect(body).toContain("`2026-11-06-b/en`: queued by a newer commit");
    expect(body).not.toContain("Skipped posts:");
  });

  it("lists the posts brought back and the ones the operator canceled", () => {
    const body = enqueueComment({
      status: "ok",
      summary: {
        scheduled: 1, updated: 1, canceled: [], revived: ["2026-11-02-tip/en"],
        skipped: [{ key: "2026-11-03-x/en", kind: "operator", reason: "canceled by the operator; run weekpost restore 2026-11-03-x --account=en to bring it back" }],
      },
      runUrl: "u",
    });
    expect(body).toContain("Brought back (canceled earlier when they left the merged YAML, and now in it again):");
    expect(body).toContain("- `2026-11-02-tip/en`");
    expect(body).toContain("Left canceled, because the operator canceled them (`weekpost restore` undoes it):");
    expect(body).toContain("`2026-11-03-x/en`: canceled by the operator");
  });

  it("lists the posts skipped because their time has passed, and how to queue them", () => {
    const body = enqueueComment({
      status: "ok",
      summary: { scheduled: 1, updated: 0, canceled: [], skipped: [{ key: "2026-10-12-tip/en", kind: "past", reason: "publish time 2026-10-12T11:00:00.000Z is in the past; use --allow-past" }] },
      runUrl: "u",
    });
    expect(body).toContain("Not queued, because their publish time has already passed");
    expect(body).toContain("`allow_past`");
    expect(body).toContain("`2026-10-12-tip/en`: publish time 2026-10-12T11:00:00.000Z is in the past");
  });

  it("uses the singular and omits the skipped list when nothing was skipped", () => {
    const body = enqueueComment({ status: "ok", summary: { scheduled: 1, updated: 0, skipped: [], canceled: [] }, runUrl: "u" });
    expect(body).toContain("Scheduled 1 post, 0 skipped");
    expect(body).not.toContain("Skipped posts");
  });

  it("tells the user to re-apply the label when there is no preview, and that it needs a new review", () => {
    const body = enqueueComment({ status: "no-preview", label: "media-ok", runUrl: "u" });
    expect(body).toContain("Nothing was scheduled");
    expect(body).toContain("re-apply the `media-ok` label");
    expect(body).toContain("new media and needs a new review");
  });

  it("shows the error lines of a failure, without breaking out of the code block", () => {
    const body = enqueueComment({ status: "failed", errors: ["error 2026-W45: hash differs ```", "nothing was scheduled"], runUrl: "u" });
    expect(body).toContain("Nothing was scheduled");
    expect(body).toContain("hash differs");
    expect(body.match(/```/g)).toHaveLength(2);
  });

  it("keeps at most 20 error lines", () => {
    const errors = Array.from({ length: 30 }, (_, i) => `error ${i}`);
    const body = enqueueComment({ status: "failed", errors, runUrl: "u" });
    expect(body).toContain("error 19");
    expect(body).not.toContain("error 20");
  });

  it("does not ping people from a skip reason", () => {
    const body = enqueueComment({ status: "ok", summary: { scheduled: 0, updated: 0, skipped: [{ key: "k", reason: "see @someone" }], canceled: [] }, runUrl: "u" });
    expect(body).not.toMatch(/(^|[^`​])@someone/);
  });
});

describe("previewComment", () => {
  const week = { week: "2026-W45", spentUsd: 0.4321, budgetUsd: 5, warnings: [{ level: "warn" as const, where: "post-a", message: "caption is long" }] };

  it("lists weeks, commit, cost against the cap, warnings, the run and the preview command", () => {
    const body = previewComment({ weeks: [week], missing: [], sha: "0123456789abcdef", runUrl: "https://x/run", pr: 12, generationFailed: false });
    expect(body).toContain("2026-W45");
    expect(body).toContain("0123456");
    expect(body).not.toContain("0123456789");
    expect(body).toContain("US$0.43 of US$5.00");
    expect(body).toContain("`post-a`: caption is long");
    expect(body).toContain("https://x/run");
    expect(body).toContain("npx weekpost preview 12");
  });

  it("warns when generation failed and names the weeks without a preview", () => {
    const body = previewComment({ weeks: [], missing: ["2026-W46"], sha: "abcdef0", runUrl: "u", pr: 3, generationFailed: true });
    expect(body).toContain("Generation failed");
    expect(body).toContain("2026-W46");
  });

  it("caps the warnings list", () => {
    const warnings = Array.from({ length: 30 }, (_, i) => ({ level: "warn" as const, where: `w${i}`, message: "m" }));
    const body = previewComment({ weeks: [{ ...week, warnings }], missing: [], sha: "abcdef0", runUrl: "u", pr: 1, generationFailed: false });
    expect(body).toContain("`w9`");
    expect(body).not.toContain("`w10`");
    expect(body).toContain("20 more");
  });

  it("lists the queued posts that were canceled because they left the merged YAML", () => {
    const body = enqueueComment({
      status: "ok", runUrl: "u",
      summary: { scheduled: 1, updated: 0, skipped: [], canceled: [{ key: "2026-11-03-tomatoes/en", reason: "the post is no longer in the week's YAML" }] },
    });
    expect(body).toContain("1 canceled");
    expect(body).toContain("Canceled posts (no longer in the merged YAML):");
    expect(body).toContain("- `2026-11-03-tomatoes/en`: the post is no longer in the week's YAML");
  });

  it("does not claim that nothing was written partially when the enqueue fails", () => {
    const body = enqueueComment({ status: "failed", errors: ["boom"], runUrl: "u" });
    expect(body).not.toContain("Nothing was written partially");
    expect(body).toContain("Some rows may have been written; running the enqueue again converges");
  });
});
