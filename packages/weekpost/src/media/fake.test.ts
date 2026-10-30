import { describe, expect, it } from "vitest";
import { mediaDuration } from "../render/reel.ts";
import { fakeClient, placeholderPng, silentMp3 } from "./fake.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fake media client", () => {
  it("draws a valid PNG with the size of the requested aspect ratio", async () => {
    const { bytes, mediaType, costUsd } = await fakeClient().image({ aspect_ratio: "1:2" });
    expect(mediaType).toBe("image/png");
    expect(costUsd).toBe(0);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(bytes.readUInt32BE(16)).toBe(360);
    expect(bytes.readUInt32BE(20)).toBe(720);
    expect(placeholderPng(2, 2).length).toBeGreaterThan(30);
  });

  it("makes silent narration whose length follows the text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weekpost-fake-"));
    const file = join(dir, "n.mp3");
    writeFileSync(file, await silentMp3("x".repeat(150)));
    expect(Math.abs((await mediaDuration(file)) - 10)).toBeLessThan(0.5);
  });

  it("answers the coherence check with a passing verdict", async () => {
    const { json } = await fakeClient().chat({});
    const args = (json as { choices: { message: { tool_calls: { function: { arguments: string } }[] } }[] }).choices[0].message.tool_calls[0].function.arguments;
    expect(JSON.parse(args).shows).toBe(true);
  });
});
