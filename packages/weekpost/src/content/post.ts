// Contract of content/<YYYY-Www>/posts.yaml (version 1), built from the project config.
import { z } from "zod";
import type { WeekpostConfig } from "../config/schema.ts";
import { SEASONS } from "./season.ts";

// The contract version this weekpost writes and the oldest one it still reads.
// A week keeps the version it was written in; see `READERS` in week.ts.
export const CONTENT_VERSION = 1;
export const MIN_CONTENT_VERSION = 1;
export const IMAGE_MODELS = ["seedream-4.5", "gpt-image-2"] as const;

const nonEmpty = z.string().trim().min(1, "text is empty");

// Text per account, keyed by account id. Which accounts are required depends on the post's `accounts`
// (checked in week.ts); here only unknown account ids are rejected.
export type Text = Record<string, string>;

const imagePrompt = z.string().trim().min(1, "image_prompt is empty");

export function buildPostSchema(config: WeekpostConfig) {
  const ids = Object.keys(config.accounts);
  const known = (id: string) => ids.includes(id);
  const unknownAccount = (id: string) => `unknown account "${id}" (accounts in the config: ${ids.join(", ")})`;

  const textSchema = z.record(z.string(), nonEmpty).superRefine((t, ctx) => {
    // An unknown key is often an unquoted comma inside { en: ..., pt: ... }.
    for (const id of Object.keys(t)) if (!known(id)) ctx.addIssue({ code: "custom", path: [id], message: `${unknownAccount(id)}; text with a comma inside "{ }" needs quotes` });
  });
  const accountId = z.string().refine(known, { error: (iss) => unknownAccount(String(iss.input)) });
  const imageModel = z.enum(IMAGE_MODELS, { error: `use ${IMAGE_MODELS.join(" or ")}` });
  const slideSchema = z
    .object({
      kicker: textSchema,
      title: textSchema,
      sub: textSchema,
      tip: textSchema.optional(),
      dark: z.boolean(),
      image_prompt: imagePrompt,
      image_model: imageModel.optional(),
    })
    .strict();

  // Reel segment: generated image (`image_prompt`) or a versioned real photo (`image_file`, path relative to
  // content/<week>/, first segment only: it becomes the Reel cover). File, format and metadata: media/realImage.ts.
  const segmentSchema = z
    .object({
      text: textSchema,
      image_prompt: imagePrompt.optional(),
      image_file: z.string().trim().min(1, "image_file is empty").optional(),
      seconds: z.number().min(1, "segment shorter than 1 s"),
    })
    .strict()
    .refine((s) => (s.image_prompt === undefined) !== (s.image_file === undefined), { message: "use image_prompt or image_file (exactly one)" });

  const base = {
    id: z.string().regex(/^[a-z0-9-]+$/, "id: lowercase letters, digits and hyphens"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date as YYYY-MM-DD"),
    accounts: z.array(accountId).min(1, "at least one account"),
    times: z.record(z.string(), z.string()), // format is checked in week.ts, together with missing times
    pillar: z.string().refine((p) => config.pillars.includes(p), { error: (iss) => `"${String(iss.input)}" is not a pillar in the config (use: ${config.pillars.join(", ")})` }),
    // Season the post talks about; the check rejects it when it is not the season of some account in `accounts` on `date`.
    season: z.enum(SEASONS, { error: `use ${SEASONS.join(", ")}` }).optional(),
    image_model: imageModel.optional(),
    caption: textSchema,
    cta: textSchema,
    link: textSchema,
    notes: z.string().optional(),
  };

  const variantSchema = z.enum(["voice", "silent"]);
  const variantByAccount = z.record(z.string(), variantSchema).superRefine((v, ctx) => {
    for (const id of Object.keys(v)) if (!known(id)) ctx.addIssue({ code: "custom", path: [id], message: unknownAccount(id) });
  });

  return z.discriminatedUnion("type", [
    z.object({ ...base, type: z.literal("carousel"), slides: z.array(slideSchema).min(2, "2 to 10 slides").max(10, "2 to 10 slides") }).strict(),
    z
      .object({
        ...base,
        type: z.literal("reel"),
        reel: z
          .object({
            segments: z
              .array(segmentSchema)
              .min(1, "at least one segment")
              .superRefine((segs, ctx) =>
                segs.forEach((s, i) => {
                  if (i > 0 && s.image_file) ctx.addIssue({ code: "custom", path: [i, "image_file"], message: "image_file only on the 1st segment (it is the Reel cover)" });
                }),
              ),
            narration: textSchema,
            voice: z.record(z.string(), z.string().min(1)).optional(),
            // Track file name under assets/music/ (no extension) or "none"; no field means no music.
            // The check that the file exists lives in load.ts, which knows the project directory.
            music: z.string().trim().min(1, "music is empty").optional(),
            // Published version: with voice (default) or without, for all accounts or per account.
            variant: z.union([variantSchema, variantByAccount]).optional(),
            // Closing card with the CTA (on when absent); false turns it off.
            cta_card: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("story"),
        story: z.object({ text: textSchema, link_utm_content: z.string().min(1), image_prompt: imagePrompt.optional() }).strict(),
      })
      .strict(),
  ]);
}

export type PostSchema = ReturnType<typeof buildPostSchema>;
export type Post = z.infer<PostSchema>;
export type Slide = Extract<Post, { type: "carousel" }>["slides"][number];

export type Issue = { level: "error" | "warn"; where: string; message: string; /** Set by `checkContent` in "past weeks" mode. */ week?: string };

// All text fields of the post, with the path used in messages.
export function textFields(post: Post): { path: string; text: Text }[] {
  const out: { path: string; text: Text }[] = [];
  if (post.type === "carousel") {
    post.slides.forEach((s, i) => {
      for (const k of ["kicker", "title", "sub", "tip"] as const) if (s[k]) out.push({ path: `slides[${i}].${k}`, text: s[k]! });
    });
  }
  if (post.type === "reel") {
    post.reel.segments.forEach((s, i) => out.push({ path: `reel.segments[${i}].text`, text: s.text }));
    out.push({ path: "reel.narration", text: post.reel.narration });
  }
  if (post.type === "story") out.push({ path: "story.text", text: post.story.text });
  out.push({ path: "caption", text: post.caption }, { path: "cta", text: post.cta }, { path: "link", text: post.link });
  return out;
}
