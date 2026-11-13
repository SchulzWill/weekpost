import { describe, expect, it } from "vitest";
import type { Manifest } from "../render/manifest.ts";
import type { Post } from "../content/post.ts";
import { packagePlan } from "./packagePlan.ts";

const H = "a".repeat(64);
const carousel = {
  id: "2026-10-12-carousel-rain", date: "2026-10-12", type: "carousel", accounts: ["en", "a"],
  times: { en: "11:00", a: "15:00" }, link: { en: "https://x.example/en?u=1", a: "https://x.example/a?u=1" },
} as unknown as Post;
const reel = { ...carousel, id: "2026-10-14-reel-ink", date: "2026-10-14", type: "reel", accounts: ["en"], times: { en: "11:00" } } as unknown as Post;
const accounts = { en: { handle: "hortaviva.en", timeZone: "Europe/London" }, a: { handle: "hortaviva.a", timeZone: "Europe/Lisbon" } };

const acct = (files: string[], over = {}) => ({ files, publish: files, caption: "Caption.", sha256: Object.fromEntries(files.map((f) => [f, H])), ...over });
const entry = (p: Post, accts: Manifest["posts"][number]["accounts"], over = {}) => ({
  id: p.id, type: p.type, date: p.date, times: p.times, timeZones: { en: "Europe/London", a: "Europe/Lisbon" }, contentHash: H, accounts: accts, coherence: [], ...over,
});
const manifest = {
  version: 1, generator: "weekpost@0", week: "2026-W42", spentUsd: 0, budgetUsd: 5, warnings: [],
  posts: [
    entry(carousel, {
      en: acct(["2026-10-12-carousel-rain/en/01.jpg", "2026-10-12-carousel-rain/en/02.jpg"], { caption: "Caption EN.\n\nLink in bio." }),
      a: acct(["2026-10-12-carousel-rain/a/01.jpg"]),
    }),
    entry(reel, {
      en: {
        files: ["2026-10-14-reel-ink/en/voice.mp4", "2026-10-14-reel-ink/en/silent.mp4", "2026-10-14-reel-ink/en/cover.jpg"],
        publish: ["2026-10-14-reel-ink/en/silent.mp4"], cover: "2026-10-14-reel-ink/en/cover.jpg", caption: "Reel caption.",
        sha256: { "2026-10-14-reel-ink/en/silent.mp4": H, "2026-10-14-reel-ink/en/cover.jpg": H },
      },
    }),
  ],
} as unknown as Manifest;

describe("packagePlan: Story", () => {
  const story = { ...carousel, id: "2026-10-13-story-tip", date: "2026-10-13", type: "story", accounts: ["en"], times: { en: "11:00" } } as unknown as Post;
  const art = ["2026-10-13-story-tip/en/story.jpg", "2026-10-13-story-tip/en/story-manual.jpg"];
  const plan = (over: Record<string, unknown>, account = {}) =>
    packagePlan({ ...manifest, posts: [entry(story, { en: { ...acct(art), ...account } }, over)] } as unknown as Manifest, [story], accounts)[0];

  it("copies the manual art, not the published one, and says when it goes out without the sticker", () => {
    const item = plan({ storyMode: "manual", fallbackAfterMinutes: 120 }, { publish: [art[0]], manual: art[1] });
    expect(item.files).toEqual([{ from: art[1], to: "story-manual.jpg" }]);
    expect(item.texts["time.txt"]).toContain("publishing: post it by hand with the link sticker until 13:00; after that it goes out without the sticker\n");
  });

  it("asks for the sticker with no deadline when there is no fallback", () => {
    expect(plan({ storyMode: "manual", fallbackAfterMinutes: null }, { publish: [art[0]], manual: art[1] }).texts["time.txt"]).toContain("publishing: post it by hand with the link sticker\n");
  });

  it("copies the published art of an auto Story and says it goes out on its own", () => {
    const item = plan({ storyMode: "auto" }, { files: [art[0]], publish: [art[0]], sha256: { [art[0]]: H } });
    expect(item.files).toEqual([{ from: art[0], to: "story.jpg" }]);
    expect(item.texts["time.txt"]).toContain("it goes out on its own");
  });
});

describe("packagePlan", () => {
  const plan = packagePlan(manifest, [carousel, reel], accounts);

  it("makes one folder per day and account, with a subfolder per post", () => {
    expect(plan.map((p) => p.dir)).toEqual([
      "2026-10-12-en/1100-carousel-carousel-rain",
      "2026-10-12-a/1500-carousel-carousel-rain",
      "2026-10-14-en/1100-reel-reel-ink",
    ]);
  });

  it("copies what is published, in order, and nothing else", () => {
    expect(plan[0].files).toEqual([
      { from: "2026-10-12-carousel-rain/en/01.jpg", to: "01.jpg" },
      { from: "2026-10-12-carousel-rain/en/02.jpg", to: "02.jpg" },
    ]);
    expect(plan[2].files).toEqual([
      { from: "2026-10-14-reel-ink/en/silent.mp4", to: "silent.mp4" },
      { from: "2026-10-14-reel-ink/en/cover.jpg", to: "cover.jpg" },
    ]);
  });

  it("writes the manifest caption, the schedule with its time zone, and the link", () => {
    expect(plan[0].texts["caption.txt"]).toBe("Caption EN.\n\nLink in bio.\n");
    expect(plan[1].texts["time.txt"]).toBe("date: 2026-10-12\ntime: 15:00\ntime zone: Europe/Lisbon\naccount: @hortaviva.a\ntype: carousel\npost: 2026-10-12-carousel-rain\n");
    expect(plan[1].texts["link.txt"]).toBe("https://x.example/a?u=1\n");
  });

  it("skips posts that were not generated or that failed", () => {
    expect(packagePlan({ ...manifest, posts: [] }, [carousel], accounts)).toEqual([]);
    const failed = { ...manifest, posts: [{ ...manifest.posts[0], error: "boom" }] } as Manifest;
    expect(packagePlan(failed, [carousel], accounts)).toEqual([]);
  });
});
