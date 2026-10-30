import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testBrand } from "../../test/fixtures/brand.ts";
import { backgroundArgs, captionCues, chromeHtml, coverSecond, CTA_CARD_SECONDS, ctaCardHtml, cueHtml, mediaDuration, parseDuration, reelArgs, reelOverlays, runFfmpeg, ffmpegBin, SAFE, SIDE, segmentTextHtml, timeline, ZOOM_SCALE } from "./reel.ts";

describe("timeline", () => {
  it("chains the segments by their seconds", () => {
    expect(timeline([3, 5, 7, 5])).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 8 },
      { start: 8, end: 15 },
      { start: 15, end: 20 },
    ]);
  });
});

describe("captionCues", () => {
  it("splits the narration by sentence and divides the duration by character count", () => {
    const cues = captionCues("Regue de manhã. A água sobe até as folhas.", 6);
    expect(cues.map((c) => c.text)).toEqual(["Regue de manhã.", "A água sobe até as folhas."]);
    expect(cues[0].start).toBe(0);
    expect(cues[0].end).toBeCloseTo((15 / 41) * 6, 2);
    expect(cues[1].end).toBeCloseTo(6, 5);
  });

  it("splits long sentences into two caption lines at a semicolon or colon", () => {
    const cues = captionCues("Antes de adubar, descubra a causa: pode ser sol demais, um vaso sem furo ou solo muito compactado.", 8);
    expect(cues.map((c) => c.text)).toEqual(["Antes de adubar, descubra a causa:", "pode ser sol demais, um vaso sem furo ou solo muito compactado."]);
  });
});

describe("coverSecond", () => {
  it("1 s on normal hooks, never before the title fade ends nor after the middle of segment 1", () => {
    expect(coverSecond([3, 4])).toBe("1");
    expect(coverSecond([1.5, 4])).toBe("0.75");
    expect(coverSecond([1, 4])).toBe("0.6");
  });
});

describe("parseDuration", () => {
  it("reads the duration from the ffmpeg output", () => {
    expect(parseDuration("  Duration: 00:00:17.52, start: 0.000000, bitrate: 128 kb/s")).toBeCloseTo(17.52);
  });

  it("returns null when there is no duration", () => {
    expect(parseDuration("nada")).toBeNull();
  });
});

describe("backgroundArgs", () => {
  const input = { images: ["a.png", "b.png"], seconds: [3, 5], chrome: "chrome.png", out: "background.mp4" };
  const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

  it("puts each image full screen (1080x1920) with a slow zoom and joins the segments", () => {
    const graph = graphOf(backgroundArgs(input));
    expect(graph.match(/zoompan=/g)).toHaveLength(2);
    expect(graph).toContain("s=1080x1920");
    expect(graph).toContain("d=90:");
    expect(graph).toContain("d=150:");
    expect(graph).toContain("concat=n=2:v=1:a=0");
  });

  it("puts the frame over the photos, on all frames, once", () => {
    const args = backgroundArgs(input);
    expect(args.join(" ")).toContain("-t 8 -i chrome.png");
    expect(graphOf(args)).toContain("[photos][2:v]overlay=0:0,format=yuv420p[v]");
  });

  it("scales the crop by the zoom factor, not 2x", () => {
    expect(graphOf(backgroundArgs(input))).toContain(`scale=${Math.round(1080 * ZOOM_SCALE)}:${Math.round(1920 * ZOOM_SCALE)}`);
    expect(ZOOM_SCALE).toBeLessThan(2);
  });

  it("outputs no audio, in fast high-quality H.264 (the final version re-encodes)", () => {
    const args = backgroundArgs(input).join(" ");
    expect(args).toContain("-an");
    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-crf 12");
    expect(args).toContain("-preset veryfast");
    expect(args).toContain("-t 8");
    expect(args.endsWith("background.mp4")).toBe(true);
  });
});

describe("reelArgs", () => {
  const base = {
    background: "background.mp4",
    seconds: [3, 5],
    overlays: [
      { file: "t0.png", start: 0, end: 3, fade: true },
      { file: "c0.png", start: 3, end: 8, fade: false },
    ],
    out: "out.mp4",
  };
  const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

  it("produces 1080x1920 at 30 fps in H.264 yuv420p with faststart and total duration", () => {
    const args = reelArgs({ ...base, audio: "n.mp3" }).join(" ");
    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-pix_fmt yuv420p");
    expect(args).toContain("-movflags +faststart");
    expect(args).toContain("-r 30");
    expect(args).toContain("-t 8");
  });

  it("uses the prebuilt background as the first input, without redoing the zoom or the frame", () => {
    const args = reelArgs(base);
    expect(args.slice(0, 6)).toEqual(["-y", "-hide_banner", "-loglevel", "error", "-i", "background.mp4"]);
    expect(graphOf(args)).not.toContain("zoompan");
    expect(args.join(" ")).not.toContain("chrome");
  });

  it("decodes each layer only in its window (-itsoffset and -t), not on all frames", () => {
    const args = reelArgs(base).join(" ");
    expect(args).toContain("-itsoffset 0 -t 3 -i t0.png");
    expect(args).toContain("-itsoffset 3 -t 5 -i c0.png");
  });

  it("shows each text layer only in its interval, with fade-in when requested", () => {
    const graph = graphOf(reelArgs(base));
    expect(graph).toContain("fade=t=in:st=0:d=0.4:alpha=1");
    expect(graph).toContain("[0:v][o0]overlay=0:0:eof_action=pass:enable='between(t,0,3)'[b0]");
    expect(graph).toContain("[b0][2:v]overlay=0:0:eof_action=pass:enable='between(t,3,8)'[b1]");
    expect(graph).toContain("enable='between(t,3,8)'");
    expect(graph.match(/fade=t=in/g)).toHaveLength(1);
  });

  it("with narration, maps the audio as AAC to the end of the video", () => {
    const args = reelArgs({ ...base, audio: "n.mp3" });
    expect(args.join(" ")).toContain("-c:a aac");
    expect(graphOf(args)).toContain("apad");
  });

  it("without narration there is no audio track", () => {
    const args = reelArgs(base).join(" ");
    expect(args).toContain("-an");
    expect(args).not.toContain("aac");
  });
});

describe("reelArgs with music", () => {
  const base = { background: "background.mp4", seconds: [8], overlays: [], out: "o.mp4" };
  const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

  it("with voice: looped, quiet music (-30 LUFS), mixed with the voice and the mix normalized for Instagram", () => {
    const args = reelArgs({ ...base, audio: "n.mp3", music: "m.mp3" });
    const g = graphOf(args);
    expect(args.join(" ")).toContain("-stream_loop -1 -i m.mp3");
    expect(g).toContain("loudnorm=I=-30");
    expect(g).toContain("amix=inputs=2");
    expect(g).toContain("loudnorm=I=-16");
    expect(g).toContain("afade=t=out:st=6.5:d=1.5");
    expect(args.join(" ")).toContain("-c:a aac");
  });

  it("without voice: music only, at the Instagram volume", () => {
    const g = graphOf(reelArgs({ ...base, music: "m.mp3" }));
    expect(g).toContain("loudnorm=I=-16");
    expect(g).not.toContain("amix");
    expect(reelArgs({ ...base, music: "m.mp3" }).join(" ")).not.toContain("-an");
  });
});

describe("reelArgs with music: real ffmpeg", () => {
  // Regression: loudnorm returns audio with no channel layout; the following aresample broke the graph
  // ("Cannot select channel layout") only in the music-without-voice branch.
  it("without voice: the graph runs in ffmpeg and the output has the requested duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-musica-"));
    const png = join(dir, "a.png");
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=teal:s=64x64", "-frames:v", "1", png]);
    const out = join(dir, "o.mp4");
    const fundo = join(dir, "background.mp4");
    await runFfmpeg(backgroundArgs({ images: [png], seconds: [3], chrome: png, out: fundo }));
    const tone = join(dir, "tone.wav");
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", tone]);
    await runFfmpeg(reelArgs({ background: fundo, seconds: [3], overlays: [], music: tone, out }));
    expect(await mediaDuration(out)).toBeGreaterThan(2.9);
  }, 60_000);

  it("two segments: the background has the sum of the seconds and is reused by two versions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-fundo-"));
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=teal:s=64x128", "-frames:v", "1", a]);
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=orange:s=64x128", "-frames:v", "1", b]);
    const fundo = join(dir, "background.mp4");
    await runFfmpeg(backgroundArgs({ images: [a, b], seconds: [1, 2], chrome: a, out: fundo }));
    expect(await mediaDuration(fundo)).toBeCloseTo(3, 0);
    for (const nome of ["x.mp4", "y.mp4"]) {
      const out = join(dir, nome);
      await runFfmpeg(reelArgs({ background: fundo, seconds: [1, 2], overlays: [{ file: b, start: 0, end: 1, fade: true }], out }));
      expect(await mediaDuration(out)).toBeGreaterThan(2.9);
    }
  }, 60_000);
});

describe("reelArgs: layers per window, real ffmpeg", () => {
  // Each layer decodes only in its window (-itsoffset): it must appear only between start and end, with the requested fade-in.
  it("shows the red layer from 2 to 5 s (fade) and the blue one from 5 to 8 s, and nothing outside them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-ervas-"));
    const fundo = join(dir, "background.mp4");
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x128:r=30", "-t", "10", "-pix_fmt", "yuv420p", fundo]);
    const red = join(dir, "r.png");
    const blue = join(dir, "b.png");
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x128,format=rgba", "-frames:v", "1", red]);
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x128,format=rgba", "-frames:v", "1", blue]);
    const out = join(dir, "o.mp4");
    await runFfmpeg(reelArgs({ background: fundo, seconds: [10], overlays: [{ file: red, start: 2, end: 5, fade: true }, { file: blue, start: 5, end: 8, fade: false }], out }));
    const pixel = (t: number) => {
      const r = spawnSync(ffmpegBin(), ["-loglevel", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-"]);
      return [...r.stdout];
    };
    expect(pixel(1)).toEqual([0, 0, 0]);
    expect(pixel(2.1)[0]).toBeGreaterThan(0);
    expect(pixel(2.1)[0]).toBeLessThan(120);
    expect(pixel(3)[0]).toBeGreaterThan(240);
    expect(pixel(6)).toEqual([0, 0, 255]);
    expect(pixel(9)).toEqual([0, 0, 0]);
  }, 60_000);
});

describe("reelOverlays", () => {
  const titles = ["t0.png", "t1.png"];
  const cues = [{ file: "c0.png", start: 0, end: 4 }, { file: "c1.png", start: 4, end: 8 }];

  it("with voice, shows only the narration captions (one text at a time)", () => {
    expect(reelOverlays("voice", { titles, cues, seconds: [3, 5] })).toEqual([
      { file: "c0.png", start: 0, end: 4, fade: false },
      { file: "c1.png", start: 4, end: 8, fade: false },
    ]);
  });

  it("without voice, shows only each segment title, with fade-in", () => {
    expect(reelOverlays("silent", { titles, cues, seconds: [3, 5] })).toEqual([
      { file: "t0.png", start: 0, end: 3, fade: true },
      { file: "t1.png", start: 3, end: 8, fade: true },
    ]);
  });
});

describe("Reel layers", () => {
  const brand = testBrand();
  const bottomOf = (html: string) => Number(html.match(/bottom:(\d+)px/)![1]);
  const topOf = (html: string) => Number(html.match(/top:(\d+)px/)![1]);

  it("title and caption stay above the 20% strip the UI covers at the bottom", () => {
    expect(bottomOf(segmentTextHtml(brand, "Título", "a"))).toBeGreaterThanOrEqual(SAFE.bottom);
    expect(bottomOf(cueHtml(brand, "Frase.", "a"))).toBeGreaterThanOrEqual(SAFE.bottom);
    expect(SAFE.bottom).toBe(Math.round(1920 * 0.2));
  });

  it("the logo sits below the top 14% strip", () => {
    const html = chromeHtml(brand, "a");
    expect(topOf(html)).toBeGreaterThanOrEqual(SAFE.top);
    expect(SAFE.top).toBe(Math.round(1920 * 0.14));
  });

  it("title, caption and logo share the side inset and the caption stays clear of the right-hand buttons", () => {
    const leftOf = (html: string) => Number(html.match(/left:(\d+)px/g)!.at(-1)!.match(/\d+/)![0]);
    expect(SIDE).toBe(100);
    expect(leftOf(cueHtml(brand, "Frase.", "a"))).toBe(SIDE);
    expect(leftOf(segmentTextHtml(brand, "Título", "a"))).toBe(SIDE);
    expect(chromeHtml(brand, "a")).toContain(`.brand{position:absolute;left:${SIDE}px`);
    expect(cueHtml(brand, "Frase.", "a")).toContain(`right:${SAFE.right}px`);
    expect(cueHtml(brand, "Frase.", "a")).toContain("text-wrap:balance");
  });

  it("the frame gradients come from the brand dark color, not a fixed one", () => {
    const html = chromeHtml(brand, "a");
    expect(html).toContain("rgba(23,58,32,0.55)");
    expect(html).toContain("rgba(23,58,32,0.88)");
  });

  it("every layer uses the brand font and the language of the account", () => {
    for (const html of [chromeHtml(brand, "b"), segmentTextHtml(brand, "T", "b"), cueHtml(brand, "F.", "b"), ctaCardHtml(brand, "C", "b")]) {
      expect(html).toContain('lang="pt-BR"');
      expect(html).toContain('font-family:"Test Sans",sans-serif');
      expect(html).toContain("@font-face");
    }
  });

  it("the frame carries no label on the image (the notice goes in the caption)", () => {
    const html = chromeHtml(brand, "a");
    expect(html).not.toContain('class="tag"');
    expect(html).not.toContain("ilustrativa");
  });
});

describe("closing CTA card", () => {
  const base = { background: "background.mp4", seconds: [3, 5], overlays: [{ file: "c0.png", start: 0, end: 8, fade: false }], audio: "n.mp3", out: "out.mp4" };
  const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];
  const card = { file: "cta.png", seconds: CTA_CARD_SECONDS };

  it("lasts between 2.5 and 3 s", () => {
    expect(CTA_CARD_SECONDS).toBeGreaterThanOrEqual(2.5);
    expect(CTA_CARD_SECONDS).toBeLessThanOrEqual(3);
  });

  it("on: extends the video, shows the card after the segments and the total duration includes it", () => {
    const args = reelArgs({ ...base, ctaCard: card });
    const g = graphOf(args);
    expect(g).toContain(`tpad=stop_mode=clone:stop_duration=${CTA_CARD_SECONDS}`);
    expect(args.join(" ")).toContain(`-itsoffset 8 -t ${CTA_CARD_SECONDS} -i cta.png`);
    expect(g).toContain(`enable='between(t,8,${8 + CTA_CARD_SECONDS})'`);
    expect(args.join(" ")).toContain(`-t ${8 + CTA_CARD_SECONDS} out.mp4`);
  });

  it("on: the music covers the total duration (fade-out at the end of the card)", () => {
    const g = graphOf(reelArgs({ ...base, music: "m.mp3", ctaCard: card }));
    expect(g).toContain(`atrim=0:${8 + CTA_CARD_SECONDS}`);
    expect(g).toContain(`afade=t=out:st=${8 + CTA_CARD_SECONDS - 1.5}:d=1.5`);
  });

  it("off: same as the Reel without a card, no tpad and no extra input", () => {
    const args = reelArgs(base);
    expect(graphOf(args)).not.toContain("tpad");
    expect(args.join(" ")).not.toContain("cta.png");
    expect(args.join(" ")).toContain("-t 8 out.mp4");
  });

  it("HTML: opaque dark background, light text, logo and the escaped CTA, outside the UI strips", () => {
    const html = ctaCardHtml(testBrand(), 'Free trial <b>: link in bio.', "b");
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain("background:#173A20");
    expect(html).toContain("Free trial &lt;b&gt;: link in bio.");
    expect(html).toContain('aria-label="Horta Viva"');
    expect(html).toContain(`right:${SAFE.right}px`);
  });
});

describe("closing CTA card: real ffmpeg", () => {
  it("the video gains the card duration and the last frame is the card", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-cta-"));
    const fundo = join(dir, "background.mp4");
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x128:r=30", "-t", "2", "-pix_fmt", "yuv420p", fundo]);
    const cartao = join(dir, "cta.png");
    await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x128,format=rgba", "-frames:v", "1", cartao]);
    const out = join(dir, "o.mp4");
    await runFfmpeg(reelArgs({ background: fundo, seconds: [2], overlays: [], ctaCard: { file: cartao, seconds: CTA_CARD_SECONDS }, out }));
    expect(await mediaDuration(out)).toBeCloseTo(2 + CTA_CARD_SECONDS, 0);
    const raw = join(dir, "ultimo.rgb");
    await runFfmpeg(["-y", "-loglevel", "error", "-ss", String(2 + CTA_CARD_SECONDS - 0.3), "-i", out, "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", raw]);
    const [r, , b] = readFileSync(raw);
    expect(r).toBeGreaterThan(200);
    expect(b).toBeLessThan(60);
  }, 60_000);
});
