// manifest.json of a generated week (version 1): the contract between `weekpost generate` and whatever
// publishes the week. What is published is exactly what `publish` lists, and `sha256` pins the bytes the
// preview showed. Size limits protect the storage and API that receive the manifest.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const MANIFEST_VERSION = 1;

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
// <post-id>/<account>/<name>: relative, three plain segments, no "..", no encoding, no backslash.
const pathPattern = (ext: string) => new RegExp(`^[a-z0-9-]{1,100}/[a-z][a-z0-9-]{0,15}/${SEGMENT}\\.(${ext})$`);
const mediaPath = z.string().max(300).regex(pathPattern("jpg|mp4"), "use <post-id>/<account>/<name>.jpg or .mp4, relative, without ..");
const audioPath = z.string().max(300).regex(pathPattern("mp3"), "use <post-id>/<account>/<name>.mp3, relative, without ..");
const accountId = z.string().regex(/^[a-z][a-z0-9-]{0,15}$/, "account id: lowercase letters, digits and hyphens");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "use a lowercase hex sha-256");

const issueSchema = z.strictObject({ level: z.enum(["error", "warn"]), where: z.string().max(200), message: z.string().max(2000) });

const accountSchema = z
  .strictObject({
    // Everything the preview shows, relative to out/<week>/.
    files: z.array(mediaPath).max(200),
    // What goes live, in order: a carousel lists every slide, a Reel the chosen version, a Story its JPEG.
    publish: z.array(mediaPath).min(1).max(10),
    // Reel cover (cover_url); without it the platform uses the first frame.
    cover: mediaPath.optional(),
    audio: audioPath.optional(),
    music: z.string().max(300).optional(),
    caption: z.string().max(10_000),
    // Hash of each file in `publish` and of `cover`.
    sha256: z.record(mediaPath, sha256),
  })
  .superRefine((a, ctx) => {
    for (const f of a.publish) if (!a.files.includes(f)) ctx.addIssue({ code: "custom", path: ["publish"], message: `${f} is in publish but not listed in files` });
    const pinned = new Set([...a.publish, ...(a.cover ? [a.cover] : [])]);
    for (const f of pinned) if (!(f in a.sha256)) ctx.addIssue({ code: "custom", path: ["sha256", f], message: `missing sha256 for ${f}` });
    for (const f of Object.keys(a.sha256)) if (!pinned.has(f)) ctx.addIssue({ code: "custom", path: ["sha256", f], message: `sha256 for ${f}, which is neither in publish nor the cover` });
  });

export const manifestSchema = z.strictObject({
  version: z.literal(MANIFEST_VERSION, { error: `use version ${MANIFEST_VERSION}` }),
  generator: z.string().max(100),
  week: z.string().regex(/^\d{4}-W\d{2}$/),
  spentUsd: z.number(),
  budgetUsd: z.number(),
  warnings: z.array(issueSchema).max(500),
  posts: z
    .array(
      z.strictObject({
        id: z.string().max(100),
        type: z.enum(["carousel", "reel", "story"]),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        times: z.record(accountId, z.string().max(16)),
        // IANA zone each account's `times` are local to, copied from the config at generation.
        timeZones: z.record(accountId, z.string().max(64)),
        // sha-256 of the post as written in posts.yaml (see content/hash.ts).
        contentHash: sha256,
        accounts: z.record(accountId, accountSchema),
        coherence: z.array(z.strictObject({ index: z.number().int(), shows: z.boolean(), reason: z.string().max(2000) })).max(200),
        // A post with an error is not queued.
        error: z.string().max(2000).optional(),
      }),
    )
    .max(200),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestAccount = z.infer<typeof accountSchema>;

export const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Compares every recorded hash with the file in `weekDir` (out/<week>/). Returns one line per problem.
export function verifyManifest(m: Manifest, weekDir: string): string[] {
  const problems: string[] = [];
  for (const post of m.posts) {
    for (const [account, a] of Object.entries(post.accounts)) {
      for (const [file, expected] of Object.entries(a.sha256)) {
        let actual: string;
        try {
          actual = sha256File(join(weekDir, file));
        } catch {
          problems.push(`${post.id} ${account} ${file}: missing`);
          continue;
        }
        if (actual !== expected) problems.push(`${post.id} ${account} ${file}: hash differs from the manifest`);
      }
    }
  }
  return problems;
}
