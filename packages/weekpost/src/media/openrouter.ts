// OpenRouter client (images, /audio/speech, chat). The key comes from OPENROUTER_API_KEY or from the
// project root .env.local (never from a parent folder) and is never printed. Tests inject a fake client.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "./ledger.ts";

const API = "https://openrouter.ai/api/v1";

export type Paid = { costUsd: number | null; latencyMs: number };
export interface OpenRouterClient {
  image(body: Record<string, unknown>): Promise<Paid & { bytes: Buffer; mediaType: string }>;
  speech(body: Record<string, unknown>): Promise<Paid & { bytes: Buffer }>;
  chat(body: Record<string, unknown>): Promise<Paid & { json: unknown }>;
}

export type MediaDeps = { client: OpenRouterClient; ledger: Ledger; cacheDir: string };

function readKeyFrom(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8").split("\n").find((l) => /^\s*(export\s+)?OPENROUTER_API_KEY\s*=/.test(l));
  return line?.replace(/^[^=]*=/, "").trim().replace(/^["']|["']$/g, "") || undefined;
}

// `projectRoot` is the folder that holds weekpost.config.ts; only its .env.local is read.
export function apiKey(projectRoot: string): string {
  const key = process.env.OPENROUTER_API_KEY || readKeyFrom(join(projectRoot, ".env.local"));
  if (!key) throw new Error("OPENROUTER_API_KEY is missing (set it in the environment or in .env.local at the project root)");
  return key;
}

// `title` is sent as X-Title (OpenRouter shows it in the dashboard); pass the brand name from the config.
export function openRouterClient(opts: { key: string; title: string }): OpenRouterClient {
  const headers = { Authorization: `Bearer ${opts.key}`, "Content-Type": "application/json", "X-Title": opts.title };

  async function post(path: string, body: unknown) {
    const started = Date.now();
    const res = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      // Only the status and the provider message; never headers (the key travels in Authorization).
      const text = await res.text().catch(() => "");
      let message = text.slice(0, 300);
      try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message; } catch { /* non-JSON body */ }
      throw new Error(`OpenRouter ${path} HTTP ${res.status}: ${message}`);
    }
    return { res, latencyMs };
  }

  // Real cost from the generation record (OpenRouter takes a few seconds to log it); null if it never shows up.
  async function generationCost(id: string | null): Promise<number | null> {
    if (!id) return null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      const res = await fetch(`${API}/generation?id=${encodeURIComponent(id)}`, { headers });
      if (res.ok) {
        const cost = ((await res.json()) as { data?: { total_cost?: number } }).data?.total_cost;
        if (typeof cost === "number") return cost;
      }
    }
    return null;
  }

  return {
    async image(body) {
      const { res, latencyMs } = await post("/images", body);
      const json = (await res.json()) as { data?: { b64_json?: string; url?: string; media_type?: string }[]; usage?: { cost?: number } };
      const item = json.data?.[0];
      if (!item) throw new Error("OpenRouter /images returned no image");
      const bytes = item.b64_json ? Buffer.from(item.b64_json, "base64") : Buffer.from(await (await fetch(item.url!)).arrayBuffer());
      const costUsd = typeof json.usage?.cost === "number" ? json.usage.cost : await generationCost(res.headers.get("x-generation-id"));
      return { bytes, mediaType: item.media_type ?? "image/png", costUsd, latencyMs };
    },
    async speech(body) {
      const { res, latencyMs } = await post("/audio/speech", body);
      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, costUsd: await generationCost(res.headers.get("x-generation-id")), latencyMs };
    },
    async chat(body) {
      const { res, latencyMs } = await post("/chat/completions", body);
      const json = (await res.json()) as { usage?: { cost?: number }; id?: string };
      const costUsd = typeof json.usage?.cost === "number" ? json.usage.cost : await generationCost(json.id ?? null);
      return { json, costUsd, latencyMs };
    },
  };
}

// Paid call with budget check, ledger entry and an estimated cost when OpenRouter returns no real one.
export async function paid<T extends Paid>(
  deps: MediaDeps,
  meta: { kind: "image" | "tts" | "vision"; model: string; item: string; estimateUsd: number },
  call: () => Promise<T>,
): Promise<T> {
  deps.ledger.assertBudget(meta.estimateUsd);
  let result: T;
  try {
    result = await call();
  } catch (e) {
    deps.ledger.record({ ...meta, ok: false, costUsd: 0, costSource: "estimated", latencyMs: 0, error: (e as Error).message });
    throw e;
  }
  const real = result.costUsd;
  deps.ledger.record({ kind: meta.kind, model: meta.model, item: meta.item, ok: true, costUsd: real ?? meta.estimateUsd, costSource: real == null ? "estimated" : "usage", latencyMs: result.latencyMs });
  return result;
}
