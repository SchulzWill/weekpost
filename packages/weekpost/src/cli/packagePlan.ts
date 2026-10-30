// Plan for `weekpost package`: a folder per day and account, a subfolder per post, with the media exactly as
// published plus the caption, the schedule and the link, for publishing by hand.
import type { Manifest } from "../render/manifest.ts";
import type { Post } from "../content/post.ts";

export type PackageItem = { dir: string; files: { from: string; to: string }[]; texts: Record<string, string> };
export type AccountInfo = { handle: string; timeZone: string };

const baseName = (file: string) => file.split("/").pop()!;

// Posts with an error in the manifest, or missing from it, are skipped.
export function packagePlan(manifest: Manifest, posts: Post[], accounts: Record<string, AccountInfo>): PackageItem[] {
  const items: PackageItem[] = [];
  for (const post of posts) {
    const generated = manifest.posts.find((p) => p.id === post.id);
    if (!generated || generated.error) continue;
    // The id starts with the date: the rest is the readable part of the folder name.
    const slug = post.id.startsWith(`${post.date}-`) ? post.id.slice(post.date.length + 1) : post.id;
    for (const acc of post.accounts) {
      const media = generated.accounts[acc];
      if (!media) continue;
      const time = post.times[acc] ?? "";
      const info = accounts[acc];
      const files = media.publish.map((from) => ({ from, to: baseName(from) }));
      // A Reel cover has the same name in every post folder, so it never collides with the video.
      if (media.cover) files.push({ from: media.cover, to: baseName(media.cover) });
      items.push({
        dir: `${post.date}-${acc}/${time.replace(":", "")}-${post.type}-${slug}`,
        files,
        texts: {
          "caption.txt": `${media.caption}\n`,
          "time.txt": `date: ${post.date}\ntime: ${time}\ntime zone: ${generated.timeZones[acc] ?? info?.timeZone ?? ""}\naccount: ${info ? `@${info.handle}` : acc}\ntype: ${post.type}\npost: ${post.id}\n`,
          "link.txt": `${post.link[acc] ?? ""}\n`,
        },
      });
    }
  }
  return items;
}
