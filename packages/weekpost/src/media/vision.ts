// Image-versus-text coherence: the vision model says whether the image shows what the slide text talks about.
// Never blocks: `shows: false` becomes "review" in the preview.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheKey, cached, store } from "./cache.ts";
import { paid, type MediaDeps } from "./openrouter.ts";

// Vision model used for the image-versus-text check.
export const VISION_MODEL = "anthropic/claude-sonnet-5";

export type Coherence = { shows: boolean; reason: string };

// Version of the criterion: changes the cache key whenever the prompt changes.
export const PROMPT_VERSION = "4";
const NO_ANSWER = "no valid answer from the check";

// Generic criterion; `visionHint` (config.media.visionHint) adds the domain of the project.
function instructions(lang: string, visionHint: string | undefined): string {
  return [
    "Evaluate an illustrative image for an Instagram slide.",
    "Question: does the concrete object or subject the text talks about appear in the image in a recognizable, realistic way?",
    "Example: 'ripe tomato' requires a visible ripe tomato, not just any plant.",
    "Do not require numbers, lists, actions of people, an app or abstract concepts (e.g. '7 tips', 'try it', 'subscribe'): in those cases the image only needs to fit the topic.",
    "Also answer shows=false if the image shows people, legible text or brands, or looks artificial.",
    ...(visionHint ? [`Context for this project: ${visionHint}`] : []),
    `Write the reason in ${lang}.`,
  ].join(" ");
}

const TOOL = {
  type: "function",
  function: {
    name: "evaluate_coherence",
    description: "Says whether the image clearly shows what the slide text describes.",
    parameters: {
      type: "object",
      properties: {
        shows: { type: "boolean", description: "true if the concrete object or subject of the text is visible, recognizable and realistic" },
        reason: { type: "string", description: "one short sentence, in the language requested in the instructions" },
      },
      required: ["shows", "reason"],
    },
  },
} as const;

const mime = (path: string) => (path.endsWith(".jpg") ? "image/jpeg" : path.endsWith(".webp") ? "image/webp" : "image/png");

export async function checkCoherence(req: { imagePath: string; text: string; item: string; lang: string; visionHint?: string }, deps: MediaDeps): Promise<Coherence> {
  const bytes = readFileSync(req.imagePath);
  const dir = join(deps.cacheDir, "vision");
  const key = cacheKey([VISION_MODEL, PROMPT_VERSION, req.lang, req.visionHint ?? "", cacheKey([bytes.toString("base64")]), req.text]);
  const hit = cached(dir, key);
  if (hit) return JSON.parse(readFileSync(hit, "utf8")) as Coherence;

  const result = await paid(deps, { kind: "vision", model: VISION_MODEL, item: req.item, estimateUsd: 0.02 }, () =>
    deps.client.chat({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${instructions(req.lang, req.visionHint)}\n\nSlide text: "${req.text}"` },
            { type: "image_url", image_url: { url: `data:${mime(req.imagePath)};base64,${bytes.toString("base64")}` } },
          ],
        },
      ],
      tools: [TOOL],
      tool_choice: { type: "function", function: { name: TOOL.function.name } },
      max_tokens: 300,
      provider: { data_collection: "deny" },
    }),
  );

  let verdict: Coherence = { shows: false, reason: NO_ANSWER };
  try {
    const args = (result.json as { choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[] })
      .choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    const parsed = JSON.parse(args ?? "") as Partial<Coherence>;
    if (typeof parsed.shows === "boolean" && typeof parsed.reason === "string") verdict = { shows: parsed.shows, reason: parsed.reason };
  } catch { /* answer outside the format: stays "review" */ }
  // Only a valid verdict is cached; a failure is retried on the next generation.
  if (verdict.reason !== NO_ANSWER) store(dir, key, "json", JSON.stringify(verdict));
  return verdict;
}
