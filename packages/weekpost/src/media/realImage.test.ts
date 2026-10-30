import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Post } from "../content/post.ts";
import { checkRealImages, inspectJpeg, REAL_IMAGE_MAX_BYTES } from "./realImage.ts";

// Minimal JPEG: SOI, the requested APPn segments, SOF0 with the dimensions, SOS and EOI (the parser stops at SOS).
function jpeg(o: { width?: number; height?: number; app?: { marker: number; payload: string }[] } = {}): Buffer {
  const seg = (marker: number, body: Buffer) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
  };
  const sof = Buffer.alloc(15);
  sof.writeUInt8(8, 0);
  sof.writeUInt16BE(o.height ?? 1568, 1);
  sof.writeUInt16BE(o.width ?? 1176, 3);
  sof.writeUInt8(3, 5);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    ...(o.app ?? []).map((a) => seg(a.marker, Buffer.from(a.payload, "latin1"))),
    seg(0xc0, sof),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
}

const EXIF = { marker: 0xe1, payload: "Exif\0\0MM\0*\0\0\0\x08" };
const XMP = { marker: 0xe1, payload: "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>" };
const IPTC = { marker: 0xed, payload: "Photoshop 3.0\0" };

describe("inspectJpeg", () => {
  it("reads the dimensions from SOF and reports no metadata on a clean JPEG", () => {
    expect(inspectJpeg(jpeg({ width: 1076, height: 1568 }))).toEqual({ width: 1076, height: 1568, metadata: [] });
  });

  it("acusa EXIF (onde mora o GPS), XMP e IPTC", () => {
    expect(inspectJpeg(jpeg({ app: [EXIF] })).metadata).toEqual(["EXIF"]);
    expect(inspectJpeg(jpeg({ app: [XMP, IPTC] })).metadata).toEqual(["XMP", "IPTC"]);
  });

  it("rejects what is not a JPEG", () => {
    expect(() => inspectJpeg(Buffer.from("\x89PNG\r\n\x1a\n", "latin1"))).toThrow(/not a JPEG/);
  });
});

function week(files: Record<string, Buffer>) {
  const dir = mkdtempSync(join(tmpdir(), "social-real-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const reel = (image_file: string) =>
  ({ id: "2026-10-30-r", type: "reel", reel: { segments: [{ text: {}, image_file, seconds: 3 }], narration: {} } }) as unknown as Post;
const messages = (dir: string, file: string) => checkRealImages(reel(file), dir).map((i) => i.message);

describe("checkRealImages", () => {
  it("a clean photo inside the week passes", () => {
    expect(messages(week({ "fotos/a.jpg": jpeg() }), "fotos/a.jpg")).toEqual([]);
  });

  it("fails on location metadata (EXIF) or XMP", () => {
    expect(messages(week({ "fotos/a.jpg": jpeg({ app: [EXIF] }) }), "fotos/a.jpg")).toEqual([expect.stringMatching(/EXIF.*GPS/)]);
    expect(messages(week({ "fotos/a.jpg": jpeg({ app: [XMP] }) }), "fotos/a.jpg")).toEqual([expect.stringMatching(/XMP/)]);
  });

  it("missing file, outside the week folder or with another extension", () => {
    const dir = week({ "fotos/a.png": jpeg() });
    expect(messages(dir, "fotos/b.jpg")).toEqual([expect.stringMatching(/does not exist/)]);
    expect(messages(dir, "../other/a.jpg")).toEqual([expect.stringMatching(/inside the week folder/)]);
    expect(messages(dir, "/etc/a.jpg")).toEqual([expect.stringMatching(/inside the week folder/)]);
    expect(messages(dir, "fotos/a.png")).toEqual([expect.stringMatching(/\.jpg/)]);
  });

  it("over 8 MB or too small for 1080 px", () => {
    const big = Buffer.concat([jpeg(), Buffer.alloc(REAL_IMAGE_MAX_BYTES)]);
    expect(messages(week({ "a.jpg": big }), "a.jpg")).toEqual([expect.stringMatching(/8 MB/)]);
    expect(messages(week({ "a.jpg": jpeg({ width: 640, height: 480 }) }), "a.jpg")).toEqual([expect.stringMatching(/720 px/)]);
  });

  it("a post without a real photo checks nothing", () => {
    const post = { id: "x", type: "reel", reel: { segments: [{ text: {}, image_prompt: "x", seconds: 3 }], narration: {} } } as unknown as Post;
    expect(checkRealImages(post, "/nao/existe")).toEqual([]);
  });
});
