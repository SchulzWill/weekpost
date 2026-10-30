// weekpost generate <YYYY-Www> [--project=<dir>] [--root=content] [--post=<id>] [--fake-media]
// Generates images (cached), the image-versus-text check, slides, Stories and Reels per account, and the
// preview out/<week>/index.html. With --fake-media nothing is paid or sent: placeholder images, silent narration.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/load.ts";
import type { WeekpostConfig } from "../config/schema.ts";
import { ConfigError } from "../config/parse.ts";
import { generateImage } from "../media/images.ts";
import { fakeClient } from "../media/fake.ts";
import { BudgetError, Ledger } from "../media/ledger.ts";
import { apiKey, openRouterClient, type MediaDeps } from "../media/openrouter.ts";
import { checkCoherence } from "../media/vision.ts";
import { narrate, resolveVoice } from "../media/tts.ts";
import { brandFrom } from "../render/brand.ts";
import { carouselSlideHtml, fitCarouselScale } from "../render/carousel.ts";
import { ctaCardFor, imageJobs, musicFor, musicPath, publishVariant, realImageFile } from "../render/jobs.ts";
import { withBrowser, type Measure, type Render } from "../render/png.ts";
import { MANIFEST_VERSION, manifestSchema, sha256File, verifyManifest, type Manifest } from "../render/manifest.ts";
import { previewHtml } from "../render/preview.ts";
import { backgroundArgs, captionCues, chromeHtml, coverSecond, CTA_CARD_SECONDS, ctaCardHtml, cueHtml, mediaDuration, reelArgs, reelOverlays, runFfmpeg, segmentTextHtml, SIZE } from "../render/reel.ts";
import { storyHtml } from "../render/story.ts";
import { checkContent } from "../content/load.ts";
import { captionFor } from "../lint/caption.ts";
import { contentHash } from "../content/hash.ts";
import type { Post, Text } from "../content/post.ts";
import { projectPaths, type Out } from "./check.ts";

const GENERATOR = `weekpost@${(JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as { version: string }).version}`;
const USAGE = "usage: weekpost generate <YYYY-Www> [--project=<dir>] [--root=content] [--post=<id>] [--fake-media]";

// Returns the exit code.
export async function runGenerate(args: string[], out: Out = console, cwd = process.cwd()): Promise<number> {
  const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const week = args.find((a) => !a.startsWith("--"));
  if (!week) {
    out.error(USAGE);
    return 2;
  }
  const fake = args.includes("--fake-media");
  const { projectRoot, contentRoot } = projectPaths(args, cwd);

  let config: WeekpostConfig;
  try {
    ({ config } = await loadConfig(projectRoot));
  } catch (e) {
    out.error(e instanceof ConfigError ? e.message : `error: ${(e as Error).message}`);
    return 1;
  }
  const brand = brandFrom(config, projectRoot);

  const { weeks, issues } = checkContent(contentRoot, config, week);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length || !weeks.length) {
    for (const i of errors) out.error(`error ${i.where}: ${i.message}`);
    out.error(weeks.length ? "fix the errors before generating (weekpost check)" : `week ${week} not found in ${contentRoot}`);
    return 1;
  }

  if (opt("post") && !weeks[0].posts.some((p) => p.id === opt("post"))) {
    out.error(`post ${opt("post")} not found in week ${week} (ids: ${weeks[0].posts.map((p) => p.id).join(", ")})`);
    return 1;
  }

  let client;
  try {
    client = fake ? fakeClient() : openRouterClient({ key: apiKey(projectRoot), title: config.brand.name });
  } catch (e) {
    out.error(`error: ${(e as Error).message}`);
    return 1;
  }
  const outDir = join(projectRoot, "out", week);
  mkdirSync(outDir, { recursive: true });
  const deps: MediaDeps = {
    client,
    ledger: new Ledger(join(outDir, "costs.jsonl"), config.budget.weeklyUsd),
    // Placeholders never share a cache with real media.
    cacheDir: join(projectRoot, "out", fake ? ".cache-fake" : ".cache"),
  };
  const judge = { lang: Object.values(config.accounts)[0]!.lang, visionHint: config.media.visionHint };
  const posts = weeks[0].posts.filter((p) => !opt("post") || p.id === opt("post"));
  const manifest: Manifest = { version: MANIFEST_VERSION, generator: GENERATOR, week, spentUsd: 0, budgetUsd: deps.ledger.budgetUsd, warnings: issues, posts: [] };
  const rel = (file: string) => relative(outDir, file).split("\\").join("/");
  // sha-256 of each file as it is on disk now: the manifest pins what the preview shows.
  const pin = (files: string[]) => Object.fromEntries(files.map((f) => [f, sha256File(join(outDir, f))]));
  const pad = (n: number) => String(n).padStart(2, "0");
  const accountsOf = (post: Post) => post.accounts;

  // Image of each slide or segment: the generated one (cached) or, on the Reel first segment, the real photo from the week folder.
  async function images(post: Post) {
    const files: string[] = [];
    const real = realImageFile(post);
    if (real) files[0] = resolve(weeks[0].dir, real);
    for (const job of imageJobs(post)) files[job.index] = await generateImage({ prompt: job.prompt, model: job.model, item: `${post.id}#${job.index + 1}` }, deps);
    return files;
  }

  // Text for the coherence judge: the first account that has one.
  const firstText = (t: Text) => Object.values(t)[0] ?? "";

  async function carousel(post: Extract<Post, { type: "carousel" }>, render: Render, measure: Measure, entry: Manifest["posts"][number]) {
    const imgs = await images(post);
    for (const [i, s] of post.slides.entries()) {
      const text = [firstText(s.kicker), firstText(s.title), firstText(s.sub)].filter(Boolean).join(". ");
      entry.coherence.push({ index: i, ...(await checkCoherence({ imagePath: imgs[i], text, item: `${post.id}#${i + 1}`, ...judge }, deps)) });
    }
    for (const acc of accountsOf(post)) {
      const files: string[] = [];
      for (const [i, s] of post.slides.entries()) {
        const out = join(outDir, post.id, acc, `${pad(i + 1)}.jpg`);
        const slideOpts = { index: i, total: post.slides.length, imageUrl: pathToFileURL(imgs[i]).href };
        const scale = await fitCarouselScale(brand, s, acc, slideOpts, measure, `${post.id} (${acc}) slide ${i + 1}`);
        await render(carouselSlideHtml(brand, s, acc, { ...slideOpts, scale }), out, { width: 1080, height: 1350 });
        files.push(rel(out));
      }
      entry.accounts[acc] = { files, publish: files, caption: captionFor(post, acc, config), sha256: pin(files) };
    }
  }

  async function story(post: Extract<Post, { type: "story" }>, render: Render, entry: Manifest["posts"][number]) {
    const [img] = await images(post);
    if (img) entry.coherence.push({ index: 0, ...(await checkCoherence({ imagePath: img, text: firstText(post.story.text), item: `${post.id}#1`, ...judge }, deps)) });
    for (const acc of accountsOf(post)) {
      const out = join(outDir, post.id, acc, "story.jpg");
      await render(storyHtml(brand, post.story, acc, img ? pathToFileURL(img).href : undefined), out, { width: 1080, height: 1920 });
      entry.accounts[acc] = { files: [rel(out)], publish: [rel(out)], sha256: pin([rel(out)]), caption: `${post.story.text[acc] ?? ""}\n\n[Link sticker, added when publishing: ${post.link[acc] ?? ""}]` };
    }
  }

  // Reel: with narration and silent (same timings and captions).
  async function reel(post: Extract<Post, { type: "reel" }>, render: Render, entry: Manifest["posts"][number]) {
    const imgs = await images(post);
    for (const [i, seg] of post.reel.segments.entries()) {
      if (seg.image_file) continue; // real photo: no prompt to check
      entry.coherence.push({ index: i, ...(await checkCoherence({ imagePath: imgs[i], text: firstText(seg.text), item: `${post.id}#${i + 1}`, ...judge }, deps)) });
    }
    const seconds = post.reel.segments.map((s) => s.seconds);
    const total = seconds.reduce((a, b) => a + b, 0);
    // The images are the same across accounts: the background (photos + zoom) is built once per Reel; the versions only add layers and audio.
    const background = join(outDir, post.id, "background.mp4");
    const chrome = join(outDir, post.id, "frame.png");
    let backgroundReady = false;
    for (const acc of accountsOf(post)) {
      const dir = join(outDir, post.id, acc);
      const layers = join(dir, "layers");
      const narration = await narrate({ text: post.reel.narration[acc]!, voice: resolveVoice(config.accounts, acc, post.reel.voice), item: `${post.id}#${acc}` }, deps);
      const duration = await mediaDuration(narration);
      if (duration > total) throw new Error(`narration for ${acc} lasts ${duration.toFixed(1)} s and does not fit the ${total} s of the segments: shorten the text`);
      mkdirSync(dir, { recursive: true });
      if (!backgroundReady) {
        // The frame is the same across accounts (only the HTML lang differs): once per Reel, next to the photos.
        await render(chromeHtml(brand, acc), chrome, SIZE);
        await runFfmpeg(backgroundArgs({ images: imgs, seconds, chrome, out: background }));
        backgroundReady = true;
      }
      copyFileSync(narration, join(dir, "narration.mp3"));

      const titles: string[] = [];
      for (const [i, seg] of post.reel.segments.entries()) {
        const file = join(layers, `texto-${i + 1}.png`);
        await render(segmentTextHtml(brand, seg.text[acc]!, acc), file, SIZE);
        titles.push(file);
      }
      const cues: { file: string; start: number; end: number }[] = [];
      for (const [i, cue] of captionCues(post.reel.narration[acc]!, duration).entries()) {
        const file = join(layers, `legenda-${i + 1}.png`);
        await render(cueHtml(brand, cue.text, acc), file, SIZE);
        cues.push({ file, start: cue.start, end: cue.end });
      }
      // Closing card with the account CTA (unless `reel.cta_card: false`).
      const ctaText = ctaCardFor(post, acc);
      let ctaCard: { file: string; seconds: number } | undefined;
      if (ctaText) {
        const file = join(layers, "cta-final.png");
        await render(ctaCardHtml(brand, ctaText, acc), file, SIZE);
        ctaCard = { file, seconds: CTA_CARD_SECONDS };
      }
      const withVoice = join(dir, "voice.mp4");
      const silent = join(dir, "silent.mp4");
      const overlays = (variant: "voice" | "silent") => reelOverlays(variant, { titles, cues, seconds });
      const track = musicFor(post);
      const music = track ? musicPath(projectRoot, track) : undefined;
      await runFfmpeg(reelArgs({ background, seconds, overlays: overlays("voice"), audio: narration, music, ctaCard, out: withVoice }));
      await runFfmpeg(reelArgs({ background, seconds, overlays: overlays("silent"), music, ctaCard, out: silent }));
      for (const mp4 of [withVoice, silent]) await runFfmpeg(["-y", "-loglevel", "error", "-ss", "1", "-i", mp4, "-frames:v", "1", "-q:v", "3", mp4.replace(/\.mp4$/, ".jpg")]);
      // Cover of a Reel with a real photo: the hook frame of the silent version (photo + title of the 1st segment).
      const cover = realImageFile(post) ? join(dir, "cover.jpg") : undefined;
      if (cover) await runFfmpeg(["-y", "-loglevel", "error", "-ss", coverSecond(seconds), "-i", silent, "-frames:v", "1", "-q:v", "2", cover]);
      const publish = rel(publishVariant(post, acc) === "silent" ? silent : withVoice);
      const coverFile = cover ? rel(cover) : undefined;
      entry.accounts[acc] = {
        files: [rel(withVoice), rel(silent)], publish: [publish], sha256: pin([publish, ...(coverFile ? [coverFile] : [])]), music: track ?? undefined,
        audio: rel(join(dir, "narration.mp3")), caption: captionFor(post, acc, config), ...(coverFile ? { cover: coverFile } : {}),
      };
    }
  }


  let failed = false;
  await withBrowser(async (render, measure) => {
    for (const post of posts) {
      const entry: Manifest["posts"][number] = { id: post.id, type: post.type, date: post.date, times: post.times, timeZones: Object.fromEntries(post.accounts.map((a) => [a, config.accounts[a].timeZone])), contentHash: contentHash(post), accounts: {}, coherence: [] };
      manifest.posts.push(entry);
      try {
        if (post.type === "carousel") await carousel(post, render, measure, entry);
        else if (post.type === "story") await story(post, render, entry);
        else await reel(post, render, entry);
        out.log(`ok ${post.id}`);
      } catch (e) {
        failed = true;
        entry.error = (e as Error).message;
        out.error(`error ${post.id}: ${entry.error}`);
        if (e instanceof BudgetError) break;
      }
    }
  });

  // With --post, the other posts of the previous manifest stay (if it is a valid v1 manifest).
  const previous = join(outDir, "manifest.json");
  if (opt("post") && existsSync(previous)) {
    const old = manifestSchema.safeParse(JSON.parse(readFileSync(previous, "utf8")));
    if (old.success) {
      const order = weeks[0].posts.map((p) => p.id);
      manifest.posts = [...old.data.posts.filter((p) => !manifest.posts.some((n) => n.id === p.id)), ...manifest.posts].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    } else {
      out.error("warn: the previous manifest.json is not a valid v1 manifest and was not kept");
    }
  }
  manifest.spentUsd = deps.ledger.spent();
  const checked = manifestSchema.safeParse(manifest);
  const problems = checked.success ? verifyManifest(checked.data, outDir) : checked.error.issues.map((i) => `manifest.${i.path.join(".")}: ${i.message}`);
  if (problems.length) {
    for (const p of problems) out.error(`error ${p}`);
    out.error("the manifest was not written");
    return 1;
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const labels = Object.fromEntries(Object.entries(config.accounts).map(([id, a]) => [id, { handle: a.handle, lang: a.lang }]));
  writeFileSync(join(outDir, "index.html"), previewHtml(manifest, labels));
  out.log(`preview: ${join(outDir, "index.html")} · week cost US$${manifest.spentUsd.toFixed(4)}`);
  return failed ? 1 : 0;
}
