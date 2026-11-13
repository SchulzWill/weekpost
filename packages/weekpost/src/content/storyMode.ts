import type { WeekpostConfig } from "../config/schema.ts";
import type { Post } from "./post.ts";

// How a Story is published: the post's own `story.publish`, else the `stories.publish` default of the config.
export function storyMode(post: Extract<Post, { type: "story" }>, config: Pick<WeekpostConfig, "stories">): "auto" | "manual" {
  return post.story.publish ?? config.stories.publish;
}

// Local time (HH:MM) at which a manual Story goes out without the link sticker: the post time plus the fallback delay.
export function fallbackTime(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
