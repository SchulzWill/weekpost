// Schema of weekpost.config.ts. Every rule has a message that names the field and the fix.
import { z } from "zod";

const HEX = /^#[0-9a-fA-F]{6}$/;
const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,15}$/;

import type { LintPlugin } from "../lint/plugin.ts";
import type { SourceAdapter } from "../sources/types.ts";

const text = (what: string) => z.string().trim().min(1, `${what} is empty`);
const hex = z.string().refine((v) => HEX.test(v), { error: (iss) => `${String(iss.input)} is not a #RRGGBB color` });

const colors = z.strictObject({
  primary: hex,
  dark: hex,
  bg: hex,
  fg: hex,
  muted: hex,
  tint: hex,
  onDark: hex,
  onDarkMuted: hex,
});

const FONT_EXT = /\.(woff2|woff|ttf)$/i;
const fontFiles = z
  .record(z.string().regex(/^[1-9]00$/, "use a CSS weight (100 to 900) as the key"), z.string().regex(FONT_EXT, "use a .woff2, .woff or .ttf file"))
  .superRefine((files, ctx) => {
    const weights = Object.keys(files).map(Number);
    if (!weights.includes(800)) ctx.addIssue({ code: "custom", message: "add a weight-800 file (used for titles)" });
    else if (!weights.some((w) => w >= 400 && w <= 500)) ctx.addIssue({ code: "custom", message: "add a weight-400 to 500 file (used for body text)" });
  });

const IMAGE_EXT = /\.(svg|png)$/i;
const logo = z
  .strictObject({
    file: z.string().regex(IMAGE_EXT, "use a .svg or .png file"),
    fileOnDark: z.string().regex(IMAGE_EXT, "use a .svg or .png file").optional(),
    recolor: z.strictObject({ primary: hex.optional(), fg: hex.optional() }).optional(),
  })
  .superRefine((l, ctx) => {
    const isPng = /\.png$/i.test(l.file);
    if (isPng && l.recolor) ctx.addIssue({ code: "custom", path: ["recolor"], message: "recolor only works with an .svg logo" });
    if (isPng && !l.fileOnDark) ctx.addIssue({ code: "custom", path: ["fileOnDark"], message: "a .png logo needs a version for dark backgrounds" });
  });

const brand = z.strictObject({
  name: text("brand name"),
  colors,
  font: z.strictObject({ family: text("font family"), files: fontFiles }),
  logo,
});

const lang = z.string().superRefine((v, ctx) => {
  try {
    if (Intl.getCanonicalLocales(v).length !== 1) throw new RangeError();
  } catch {
    ctx.addIssue({ code: "custom", message: `${v} is not a BCP-47 language tag (e.g. pt-BR)` });
  }
});

const timeZone = z.string().superRefine((v, ctx) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
  } catch {
    ctx.addIssue({ code: "custom", message: `${v} is not an IANA time zone (e.g. America/Sao_Paulo)` });
  }
});

const CTA_RANGE = "list 1 to 10 words or phrases, or null to turn the check off";

/** An Instagram handle: letters, digits, dots and underscores, 30 at most. Nothing that could break out of a string in generated code. */
export const handle = z.string().min(1, "handle is empty").superRefine((v, ctx) => {
  if (v.startsWith("@")) ctx.addIssue({ code: "custom", message: "write the handle without the @" });
  else if (!/^[A-Za-z0-9._]{1,30}$/.test(v)) ctx.addIssue({ code: "custom", message: "use only letters, digits, dots and underscores (30 characters at most)" });
});

const account = z.strictObject({
  handle: handle,
  lang,
  timeZone, // `times` in posts.yaml are local time in this zone
  hemisphere: z.enum(["north", "south"], { error: 'use "north" or "south"' }),
  voice: z.string().trim().min(1, "voice is empty (use a catalog voice name or ID)"),
  // Words or phrases; the carousel/Reel CTA must contain at least one (whole word, case-insensitive). No regex.
  cta: z.array(z.string().trim().min(1, "CTA entry is empty"), { error: CTA_RANGE }).min(1, CTA_RANGE).max(10, CTA_RANGE).nullable(),
  link: z.strictObject({ base: z.string().refine((v) => v.startsWith("https://"), "use an https:// URL") }),
});

const accounts = z.record(z.string(), account).superRefine((all, ctx) => {
  const ids = Object.keys(all);
  if (ids.length < 1 || ids.length > 10) ctx.addIssue({ code: "custom", message: `define 1 to 10 accounts (got ${ids.length})` });
  for (const id of ids) {
    if (!ACCOUNT_ID.test(id)) {
      ctx.addIssue({ code: "custom", path: [id], message: "account id must match ^[a-z][a-z0-9-]{0,15}$ (lowercase letters, digits, hyphens; max 16 characters)" });
    }
  }
});

const PILLARS = "list 1 to 20 pillars";

// metrics.extra: a command (program, then its arguments; no shell) that prints a JSON array of { label, value } for the weekly report.
const metrics = z.strictObject({
  extra: z
    .strictObject({
      command: z.array(z.string().min(1, "command part is empty"), { error: 'use an array: ["node", "scripts/extra-metrics.mjs"]' }).min(1, "command is empty"),
    })
    .optional(),
});

export const configSchema = z.strictObject({
  brand,
  accounts,
  pillars: z.array(text("pillar"), { error: PILLARS }).min(1, PILLARS).max(20, PILLARS),
  reel: z
    .strictObject({
      maxSeconds: z.number({ error: "use a value from 5 to 90 seconds" }).min(5, "use a value from 5 to 90 seconds").max(90, "use a value from 5 to 90 seconds"),
    })
    .default({ maxSeconds: 20 }),
  // visionHint: one sentence about the project's subject, added to the image-versus-text check prompt.
  media: z.strictObject({ visionHint: text("vision hint").optional() }).default({}),
  budget: z.strictObject({ weeklyUsd: z.number().gt(0, "must be greater than 0") }).default({ weeklyUsd: 5 }),
  // previewLabel: the pull request label that starts the media preview in CI (keep it equal to the label in weekpost-preview.yml).
  ci: z.strictObject({ previewLabel: text("preview label").refine((v) => !/[,\n]/.test(v) && v.length <= 50, "use one label of up to 50 characters, without commas") }).default({ previewLabel: "media-ok" }),
  // sources: adapters that feed `weekpost sources pull` (see src/sources). Optional; without them the week starts from BRIEF.md alone.
  sources: z.array(z.custom<SourceAdapter>((s) => typeof s === "object" && s !== null && typeof (s as { name?: unknown }).name === "string" && typeof (s as { pull?: unknown }).pull === "function", "a source must be an object with a name and a pull() function")).optional(),
  // Optional; `metrics.extra` is off unless set.
  metrics: metrics.optional(),
  lint: z.strictObject({ plugins: z.array(z.custom<LintPlugin>((p) => typeof p === "object" && p !== null && typeof (p as { name?: unknown }).name === "string", "plugin must be an object with a name")) }).default({ plugins: [] }),
});

export type WeekpostConfig = z.output<typeof configSchema>;
// What a user may write (reel, media, budget, ci and lint are optional).
export type WeekpostConfigInput = z.input<typeof configSchema>;
