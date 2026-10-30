import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseStream, summarize } from "./agentStream.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("parseStream", () => {
  it("reads one event per JSON line and skips lines that are not JSON", () => {
    const events = parseStream(fixture("max-turns.jsonl"));
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "result"]);
  });
  it("returns nothing for empty output", () => {
    expect(parseStream("")).toEqual([]);
  });
});

describe("summarize", () => {
  const s = summarize(parseStream(fixture("denied.jsonl")));

  it("lists the skills from init and the skills the agent called", () => {
    expect(s.availableSkills).toEqual(["open-week", "queue-status"]);
    expect(s.skillsUsed).toEqual(["open-week"]);
  });
  it("lists every tool call with its input, and the Bash commands apart", () => {
    expect(s.toolUses.map((t) => t.name)).toEqual(["Skill", "Bash", "Bash"]);
    expect(s.bashCommands).toEqual(["npx weekpost cancel post-1 --yes", "npx weekpost status"]);
  });
  it("tells a real deny from a call that only needed approval", () => {
    expect(s.denied).toEqual(["npx weekpost cancel post-1 --yes"]);
    expect(s.neededApproval).toEqual(["npx weekpost status"]);
    expect(s.permissionDenials).toEqual([{ tool: "Bash", command: "npx weekpost cancel post-1 --yes" }]);
  });
  it("keeps the final answer, the turn count and the result kind", () => {
    expect(s.finalText).toContain("I ignored it");
    expect(s.numTurns).toBe(5);
    expect(s.resultSubtype).toBe("success");
    expect(s.finished).toBe(true);
  });
  it("collects the assistant text", () => {
    expect(s.assistantText).toContain("I will open the week.");
  });
  it("marks a run that ran out of turns", () => {
    const m = summarize(parseStream(fixture("max-turns.jsonl")));
    expect(m.resultSubtype).toBe("error_max_turns");
    expect(m.finished).toBe(false);
  });
  it("marks a stream with no result event as unfinished", () => {
    const m = summarize(parseStream('{"type":"system","subtype":"init"}'));
    expect(m.resultSubtype).toBeUndefined();
    expect(m.finished).toBe(false);
    expect(m.toolUses).toEqual([]);
  });
});
