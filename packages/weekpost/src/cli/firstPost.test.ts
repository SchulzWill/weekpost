import { describe, expect, it } from "vitest";
import { testConfig } from "../content/fixtures.ts";
import type { NewRow, QueueRow, Storage } from "../queue/types.ts";
import { explainFailure, firstPostId, runFirstPost, type FirstPostDeps } from "./firstPost.ts";

const config = testConfig();
const START = Date.parse("2026-10-30T12:00:00Z");

function setup(over: { tty?: boolean; existing?: Partial<QueueRow>; after?: Partial<QueueRow>; afterPolls?: number; confirm?: boolean; typed?: string } = {}) {
  const lines: string[] = [];
  const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) };
  let clock = START;
  const rows: QueueRow[] = [];
  const state = { inserted: [] as NewRow[], puts: [] as string[], polls: 0, asked: 0, confirmed: 0, rendered: 0, ensured: 0 };
  const fromNew = (n: NewRow): QueueRow => ({
    ...n, cover: n.cover ?? null, link: n.link ?? null, contentHash: n.contentHash ?? null, status: n.status ?? "scheduled", attempts: 0, nextAttemptAt: null,
    claimedAt: null, containerId: null, mediaId: null, permalink: null, lastError: null, publishedAt: null, mediaPurgedAt: null, rescheduledAt: null,
  });
  if (over.existing) rows.push({ ...fromNew({ postId: firstPostId("2026-10-30"), account: "en", type: "carousel", week: "2026-W44", publishAt: new Date(START).toISOString(), caption: "x", media: ["a.jpg"], cover: null, link: null, contentHash: null }), ...over.existing });
  const deps: FirstPostDeps = {
    config,
    tty: over.tty ?? true,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    db: {
      rows: async () => {
        state.polls += 1;
        if (over.after && rows.length && state.polls > (over.afterPolls ?? 3)) Object.assign(rows[0]!, over.after);
        return [...rows];
      },
      insert: async (n) => {
        state.inserted.push(...n);
        rows.push(...n.map(fromNew));
      },
    },
    storage: {
      put: async (p: string) => {
        state.puts.push(p);
      },
      ensureBucket: async () => {
        state.ensured += 1;
      },
    } as unknown as Storage & { ensureBucket: () => Promise<void> },
    render: async () => {
      state.rendered += 1;
      return new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    },
    confirm: async () => {
      state.confirmed += 1;
      return over.confirm ?? true;
    },
    ask: async () => {
      state.asked += 1;
      return over.typed ?? "Hello from my own Worker";
    },
  };
  return { deps, out, lines, state, rows, clockNow: () => clock };
}

describe("weekpost first-post", () => {
  it("queues one row for ~1 minute ahead, waits for the permalink and prints it", async () => {
    const t = setup({ after: { status: "published", permalink: "https://www.instagram.com/p/ABC/" } });
    expect(await runFirstPost(["en", "--caption=Hi there"], t.out, "/x", t.deps)).toBe(0);
    expect(t.state.inserted).toHaveLength(1);
    const row = t.state.inserted[0]!;
    expect(row).toMatchObject({ postId: "2026-10-30-weekpost-first-post", account: "en", type: "carousel", caption: "Hi there", cover: null, link: null });
    expect(row.publishAt).toBe(new Date(START + 60_000).toISOString());
    expect(row.media).toHaveLength(1);
    expect(row.media[0]).toMatch(/^2026-W44\/2026-10-30-weekpost-first-post\/en\/[0-9a-f]{64}\.jpg$/);
    expect(t.state.puts).toEqual(row.media);
    expect(t.state.ensured).toBe(1);
    expect(t.lines.join("\n")).toContain("https://www.instagram.com/p/ABC/");
    expect(t.lines.join("\n")).toContain("@shop.en");
  });

  it("asks to confirm the handle and stops on no, writing nothing", async () => {
    const t = setup({ confirm: false });
    expect(await runFirstPost(["en", "--caption=Hi"], t.out, "/x", t.deps)).toBe(1);
    expect(t.state.confirmed).toBe(1);
    expect(t.state.inserted).toHaveLength(0);
    expect(t.state.puts).toHaveLength(0);
  });

  it("always needs a terminal: --yes does not replace it, and it skips the confirmation only with one", async () => {
    const no = setup({ tty: false });
    expect(await runFirstPost(["en", "--caption=Hi"], no.out, "/x", no.deps)).toBe(2);
    expect(no.state.inserted).toHaveLength(0);
    const yesNoTty = setup({ tty: false });
    expect(await runFirstPost(["en", "--caption=Hi", "--yes"], yesNoTty.out, "/x", yesNoTty.deps)).toBe(2);
    expect(yesNoTty.state.inserted).toHaveLength(0);
    expect(yesNoTty.lines.join("\n")).toContain("terminal");
    const yes = setup({ tty: true, after: { status: "published", permalink: "https://www.instagram.com/p/Z/" } });
    expect(await runFirstPost(["en", "--caption=Hi", "--yes"], yes.out, "/x", yes.deps)).toBe(0);
    expect(yes.state.confirmed).toBe(0);
  });

  it("asks for the caption at the prompt, and fails without one when there is no terminal", async () => {
    const t = setup({ after: { status: "published", permalink: "https://www.instagram.com/p/Q/" } });
    expect(await runFirstPost(["en"], t.out, "/x", t.deps)).toBe(0);
    expect(t.state.asked).toBe(1);
    expect(t.state.inserted[0]!.caption).toBe("Hello from my own Worker");
    const n = setup({ tty: false });
    expect(await runFirstPost(["en", "--yes"], n.out, "/x", n.deps)).toBe(2);
  });

  it("times out (default 15 minutes) and says the row is still queued", async () => {
    const t = setup();
    expect(await runFirstPost(["en", "--caption=Hi"], t.out, "/x", t.deps)).toBe(1);
    expect(t.clockNow() - START).toBeGreaterThanOrEqual(15 * 60_000);
    expect(t.clockNow() - START).toBeLessThan(16 * 60_000);
    expect(t.lines.join("\n")).toMatch(/still scheduled/);
    expect(t.lines.join("\n")).toContain("weekpost status");
  });

  it("honors --timeout in minutes", async () => {
    const t = setup();
    await runFirstPost(["en", "--caption=Hi", "--timeout=2"], t.out, "/x", t.deps);
    expect(t.clockNow() - START).toBeLessThan(3 * 60_000);
  });

  it("on failure prints the translated reason and the setup step", async () => {
    const t = setup({ after: { status: "failed", lastError: "no Instagram token for account en" } });
    expect(await runFirstPost(["en", "--caption=Hi"], t.out, "/x", t.deps)).toBe(1);
    const text = t.lines.join("\n");
    expect(text).toContain("weekpost token en");
    expect(text).toContain("docs/setup.md, step 6");
  });

  it("running it again the same day does not queue a second post", async () => {
    const first = setup({ after: { status: "published", permalink: "https://www.instagram.com/p/ABC/" } });
    await runFirstPost(["en", "--caption=Hi"], first.out, "/x", first.deps);
    // same queue, same day
    const again = setup({ existing: { status: "published", permalink: "https://www.instagram.com/p/ABC/" } });
    expect(await runFirstPost(["en", "--caption=Hi"], again.out, "/x", again.deps)).toBe(0);
    expect(again.state.inserted).toHaveLength(0);
    expect(again.state.puts).toHaveLength(0);
    expect(again.state.rendered).toBe(0);
    expect(again.lines.join("\n")).toContain("https://www.instagram.com/p/ABC/");
  });

  it("repeating while the first run is still queued waits for it instead of inserting", async () => {
    const t = setup({ existing: { status: "scheduled" }, after: { status: "published", permalink: "https://www.instagram.com/p/W/" } });
    expect(await runFirstPost(["en", "--caption=Hi"], t.out, "/x", t.deps)).toBe(0);
    expect(t.state.inserted).toHaveLength(0);
  });

  it("repeating after a failure reports it and does not queue again; a canceled row points at restore", async () => {
    const f = setup({ existing: { status: "failed", lastError: "Instagram (#190): token expired" } });
    expect(await runFirstPost(["en", "--caption=Hi"], f.out, "/x", f.deps)).toBe(1);
    expect(f.state.inserted).toHaveLength(0);
    const c = setup({ existing: { status: "canceled" } });
    expect(await runFirstPost(["en", "--caption=Hi"], c.out, "/x", c.deps)).toBe(1);
    expect(c.lines.join("\n")).toContain("weekpost restore");
    expect(c.state.inserted).toHaveLength(0);
  });

  it("rejects an unknown account and an over-long caption", async () => {
    const t = setup();
    expect(await runFirstPost(["nope", "--caption=Hi"], t.out, "/x", t.deps)).toBe(1);
    expect(await runFirstPost(["en", `--caption=${"a".repeat(2201)}`], t.out, "/x", t.deps)).toBe(1);
    expect(t.state.inserted).toHaveLength(0);
  });
});

describe("firstPostId and explainFailure", () => {
  it("is deterministic per day", () => {
    expect(firstPostId("2026-10-30")).toBe("2026-10-30-weekpost-first-post");
  });
  it("maps known worker errors to setup steps and keeps unknown ones", () => {
    expect(explainFailure("Instagram (#190): Invalid OAuth access token", "en")).toMatch(/weekpost token en/);
    expect(explainFailure("Instagram (#10): permission missing", "en")).toMatch(/instagram_business_content_publish/);
    expect(explainFailure("Meta marked the container as ERROR", "en")).toMatch(/JPEG|image/i);
    expect(explainFailure("something odd", "en")).toContain("something odd");
    expect(explainFailure(null, "en")).toMatch(/Worker logs/);
  });
});
