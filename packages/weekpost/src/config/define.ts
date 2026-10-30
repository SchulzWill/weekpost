import type { WeekpostConfigInput } from "./schema.ts";

// Typing helper for autocomplete in weekpost.config.ts; returns its input unchanged.
export function defineConfig(config: WeekpostConfigInput): WeekpostConfigInput {
  return config;
}
