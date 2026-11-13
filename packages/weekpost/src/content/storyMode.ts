import type { WeekpostConfig } from "../config/schema.ts";
import type { Post } from "./post.ts";

// How a Story is published: the post's own `story.publish`, else the `stories.publish` default of the config.
export function storyMode(post: Extract<Post, { type: "story" }>, config: Pick<WeekpostConfig, "stories">): "auto" | "manual" {
  return post.story.publish ?? config.stories.publish;
}
