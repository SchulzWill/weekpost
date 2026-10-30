import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKey } from "./cache.ts";
import { generateImage, IMAGE_MODELS } from "./images.ts";
import { BudgetError, Ledger } from "./ledger.ts";
import { apiKey, openRouterClient, type MediaDeps, type OpenRouterClient } from "./openrouter.ts";
import { narrate, resolveVoice, TTS_PRICE_PER_CHAR } from "./tts.ts";
import { checkCoherence, PROMPT_VERSION } from "./vision.ts";

function fakeClient(overrides: Partial<OpenRouterClient> = {}) {
  const calls: { kind: string; body: Record<string, unknown> }[] = [];
  const client: OpenRouterClient = {
    async image(body) {
      calls.push({ kind: "image", body });
      return { bytes: Buffer.from("png"), mediaType: "image/png", costUsd: 0.04, latencyMs: 10 };
    },
    async speech(body) {
      calls.push({ kind: "speech", body });
      return { bytes: Buffer.from("mp3"), costUsd: 0.01, latencyMs: 10 };
    },
    async chat(body) {
      calls.push({ kind: "chat", body });
      const args = JSON.stringify({ shows: false, reason: "does not show a pot" });
      return { json: { choices: [{ message: { tool_calls: [{ function: { arguments: args } }] } }] }, costUsd: 0.01, latencyMs: 10 };
    },
    ...overrides,
  };
  return { client, calls };
}

function deps(client: OpenRouterClient, budget = 5): MediaDeps {
  const dir = mkdtempSync(join(tmpdir(), "social-media-"));
  return { client, cacheDir: join(dir, "cache"), ledger: new Ledger(join(dir, "costs.jsonl"), budget) };
}

describe("cacheKey", () => {
  it("is stable and changes with any part", () => {
    expect(cacheKey(["a", "b"])).toBe(cacheKey(["a", "b"]));
    expect(cacheKey(["a", "b"])).not.toBe(cacheKey(["a", "c"]));
    expect(cacheKey(["ab", ""])).not.toBe(cacheKey(["a", "b"]));
  });
});

describe("Ledger", () => {
  it("adds up the cost and refuses the call that would pass the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "social-ledger-"));
    const ledger = new Ledger(join(dir, "costs.jsonl"), 0.05);
    ledger.record({ kind: "image", model: "m", item: "a", ok: true, costUsd: 0.04, costSource: "usage", latencyMs: 1 });
    expect(ledger.spent()).toBeCloseTo(0.04);
    expect(() => ledger.assertBudget(0.02)).toThrow(BudgetError);
    expect(() => ledger.assertBudget(0.01)).not.toThrow();
  });
});

describe("generateImage", () => {
  it("uses Seedream at 1:2 by default and the cache the second time", async () => {
    const { client, calls } = fakeClient();
    const d = deps(client);
    const first = await generateImage({ prompt: "Pot", item: "s1" }, d);
    const second = await generateImage({ prompt: "Pot", item: "s1-b" }, d);
    expect(first).toBe(second);
    expect(readFileSync(first, "utf8")).toBe("png");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ model: "bytedance-seed/seedream-4.5", aspect_ratio: "1:2" });
    expect(d.ledger.spent()).toBeCloseTo(0.04);
  });

  it("asks for GPT Image 2 without quality", async () => {
    const { client, calls } = fakeClient();
    await generateImage({ prompt: "Herb", model: "gpt-image-2", item: "s3" }, deps(client));
    expect(calls[0].body).toMatchObject({ model: "openai/gpt-image-2", aspect_ratio: "9:16" });
    expect(calls[0].body).not.toHaveProperty("quality");
    expect(IMAGE_MODELS["gpt-image-2"].id).toBe("openai/gpt-image-2");
  });

  it("does not call the network when the budget cannot fit the image", async () => {
    const { client, calls } = fakeClient();
    await expect(generateImage({ prompt: "x", item: "s1" }, deps(client, 0.01))).rejects.toThrow(BudgetError);
    expect(calls).toHaveLength(0);
  });

  it("records the failure at no cost and rethrows", async () => {
    const { client } = fakeClient({ image: async () => { throw new Error("HTTP 502"); } });
    const d = deps(client);
    await expect(generateImage({ prompt: "x", item: "s1" }, d)).rejects.toThrow("HTTP 502");
    expect(d.ledger.entries()).toMatchObject([{ ok: false, error: "HTTP 502", costUsd: 0 }]);
  });
});

describe("narrate", () => {
  it("uses the given catalog voice and caches the result", async () => {
    const { client, calls } = fakeClient();
    const d = deps(client);
    const a = await narrate({ text: "Water later.", voice: "george", item: "reel" }, d);
    await narrate({ text: "Water later.", voice: "george", item: "reel" }, d);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ model: "elevenlabs/eleven-v4", voice: "george", response_format: "mp3", input: "Water later." });
    expect(a.endsWith(".mp3")).toBe(true);
  });

  it("does not reuse the cache across voices", async () => {
    const { client, calls } = fakeClient();
    const d = deps(client);
    await narrate({ text: "Hello.", voice: "george", item: "r" }, d);
    await narrate({ text: "Hello.", voice: "sarah", item: "r" }, d);
    expect(calls.map((c) => c.body.voice)).toEqual(["george", "sarah"]);
  });

  it("estimates 0.00008 USD per character when the provider returns no cost", async () => {
    const { client } = fakeClient({ speech: async () => ({ bytes: Buffer.from("mp3"), costUsd: null, latencyMs: 1 }) });
    const d = deps(client);
    await narrate({ text: "a".repeat(1000), voice: "george", item: "r" }, d);
    expect(TTS_PRICE_PER_CHAR).toBe(0.00008);
    expect(d.ledger.entries()[0]).toMatchObject({ kind: "tts", costUsd: expect.closeTo(0.08, 6), costSource: "estimated" });
  });

  it("stops before the call when the estimate does not fit the budget", async () => {
    const { client, calls } = fakeClient();
    await expect(narrate({ text: "a".repeat(1000), voice: "george", item: "r" }, deps(client, 0.05))).rejects.toThrow(BudgetError);
    expect(calls).toHaveLength(0);
  });
});

describe("resolveVoice", () => {
  const accounts = { en: { voice: "george" }, a: { voice: "sarah" } };
  it("prefers the voice written in the post YAML", () => {
    expect(resolveVoice(accounts, "a", { a: "alice" })).toBe("alice");
  });
  it("falls back to the account voice from the config", () => {
    expect(resolveVoice(accounts, "a", { en: "alice" })).toBe("sarah");
    expect(resolveVoice(accounts, "en", undefined)).toBe("george");
  });
  it("fails clearly for an unknown account", () => {
    expect(() => resolveVoice(accounts, "xx", undefined)).toThrow(/xx/);
  });
});

describe("shared weekly budget", () => {
  it("adds up spend from every account in the same ledger", async () => {
    const { client } = fakeClient({ speech: async () => ({ bytes: Buffer.from("mp3"), costUsd: 0.03, latencyMs: 1 }) });
    const d = deps(client, 0.06);
    await narrate({ text: "one", voice: "george", item: "p#en" }, d);
    await narrate({ text: "two", voice: "sarah", item: "p#a" }, d);
    await expect(narrate({ text: "three", voice: "alice", item: "p#b" }, d)).rejects.toThrow(BudgetError);
    expect(d.ledger.entries().filter((e) => e.ok)).toHaveLength(2);
    expect(d.ledger.spent()).toBeCloseTo(0.06);
  });
});

describe("apiKey", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the key from the project root .env.local", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const root = mkdtempSync(join(tmpdir(), "weekpost-key-"));
    writeFileSync(join(root, ".env.local"), 'OPENROUTER_API_KEY="sk-test"\n');
    expect(apiKey(root)).toBe("sk-test");
  });

  it("prefers the environment variable", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "from-env");
    const root = mkdtempSync(join(tmpdir(), "weekpost-key-"));
    writeFileSync(join(root, ".env.local"), "OPENROUTER_API_KEY=from-file\n");
    expect(apiKey(root)).toBe("from-env");
  });

  it("does not look above the project root", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const parent = mkdtempSync(join(tmpdir(), "weekpost-key-"));
    writeFileSync(join(parent, ".env.local"), "OPENROUTER_API_KEY=outside\n");
    const root = join(parent, "project");
    mkdirSync(root);
    expect(() => apiKey(root)).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("openRouterClient (fetch mocked)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });

  it("sends the brand name as X-Title", async () => {
    const fetchMock = vi.fn(async () => ok({ usage: { cost: 0.01 } }));
    vi.stubGlobal("fetch", fetchMock);
    await openRouterClient({ key: "sk-test", title: "Horta Viva" }).chat({ model: "m" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["X-Title"]).toBe("Horta Viva");
  });

  it("reports only status and provider message on errors, never the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "no credits" } }), { status: 402 })));
    const err = await openRouterClient({ key: "sk-secret", title: "T" }).chat({ model: "m" }).catch((e: Error) => e);
    expect((err as Error).message).toBe("OpenRouter /chat/completions HTTP 402: no credits");
    expect((err as Error).message).not.toContain("sk-secret");
  });

  it("falls back to /generation?id= for the real cost (plan B)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => (url.includes("/generation?id=") ? ok({ data: { total_cost: 0.0123 } }) : ok({ id: "gen-1" })));
    vi.stubGlobal("fetch", fetchMock);
    const pending = openRouterClient({ key: "k", title: "T" }).chat({ model: "m" });
    await vi.runAllTimersAsync();
    expect((await pending).costUsd).toBe(0.0123);
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("https://openrouter.ai/api/v1/generation?id=gen-1");
  });
});

describe("checkCoherence", () => {
  it("asks the vision model with a forced tool and returns the verdict", async () => {
    const { client, calls } = fakeClient();
    const d = deps(client);
    const img = join(d.cacheDir, "..", "img.png");
    writeFileSync(img, "png");
    const result = await checkCoherence({ imagePath: img, text: "Basil and mint. Cracked pot.", item: "s3", lang: "pt-BR" }, d);
    expect(result).toEqual({ shows: false, reason: "does not show a pot" });
    expect(calls[0].body).toMatchObject({ model: "anthropic/claude-sonnet-5", provider: { data_collection: "deny" } });
    expect(calls[0].body.tool_choice).toMatchObject({ type: "function" });
    await checkCoherence({ imagePath: img, text: "Basil and mint. Cracked pot.", item: "s3", lang: "pt-BR" }, d);
    expect(calls).toHaveLength(1);
  });

  it("uses a generic criterion, the optional visionHint and the account language", async () => {
    const { client, calls } = fakeClient();
    const d = deps(client);
    const img = join(d.cacheDir, "..", "img.png");
    writeFileSync(img, "png");
    await checkCoherence({ imagePath: img, text: "Ripe tomato", item: "s1", lang: "pt-BR" }, d);
    await checkCoherence({ imagePath: img, text: "Ripe tomato", item: "s1", lang: "pt-BR", visionHint: "Photos of vegetable gardens" }, d);
    const prompts = calls.map((c) => JSON.stringify(c.body.messages));
    expect(calls).toHaveLength(2); // the hint changes the cache key
    expect(prompts[0]).not.toMatch(/garden|herb|pot|soil/i);
    expect(prompts[0]).toContain("pt-BR");
    expect(prompts[1]).toContain("Photos of vegetable gardens");
    expect(PROMPT_VERSION).toBe("4");
  });

  it("returns 'review' when the answer carries no tool call", async () => {
    const { client } = fakeClient({ chat: async () => ({ json: { choices: [] }, costUsd: 0, latencyMs: 1 }) });
    const d = deps(client);
    const img = join(d.cacheDir, "..", "img.png");
    writeFileSync(img, "png");
    expect(await checkCoherence({ imagePath: img, text: "x", item: "s1", lang: "en" }, d)).toEqual({ shows: false, reason: "no valid answer from the check" });
  });
});
