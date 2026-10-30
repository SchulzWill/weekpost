// Pure parser for the output of `claude -p --output-format stream-json --verbose` (one JSON event per line).
// The eval script feeds it the captured stdout; the tests feed it recorded fixtures. No I/O here.

export type StreamEvent = { type?: string; subtype?: string; [key: string]: unknown };
export type ToolUse = { name: string; input: Record<string, unknown> };

export type StreamSummary = {
  /** Skills the session listed at start (`init`). */
  availableSkills: string[];
  /** Skills the agent actually called through the Skill tool. */
  skillsUsed: string[];
  toolUses: ToolUse[];
  /** The `command` of every Bash call, in order. */
  bashCommands: string[];
  /** Bash commands whose result says the permission rules denied them ("has been denied"). */
  denied: string[];
  /** Bash commands refused only because nothing allowed them ("requires approval"). Not a deny rule. */
  neededApproval: string[];
  /** The `permission_denials` of the final event. */
  permissionDenials: { tool: string; command?: string }[];
  /** Text blocks the assistant wrote along the way. */
  assistantText: string;
  /** `result.result`: the final answer. */
  finalText: string;
  numTurns?: number;
  resultSubtype?: string | undefined;
  /** True only for a `result` of subtype `success`. */
  finished: boolean;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** One event per JSON line; lines that are not JSON objects (stray logs) are skipped. */
export function parseStream(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (isObject(v)) events.push(v as StreamEvent);
    } catch {
      // not an event
    }
  }
  return events;
}

function contentOf(event: StreamEvent): Record<string, unknown>[] {
  const message = event.message;
  return isObject(message) ? asArray(message.content).filter(isObject) : [];
}

function toolResultText(block: Record<string, unknown>): string {
  const c = block.content;
  if (typeof c === "string") return c;
  return asArray(c).filter(isObject).map((b) => asString(b.text)).join("\n");
}

export function summarize(events: StreamEvent[]): StreamSummary {
  const s: StreamSummary = {
    availableSkills: [], skillsUsed: [], toolUses: [], bashCommands: [], denied: [], neededApproval: [],
    permissionDenials: [], assistantText: "", finalText: "", finished: false,
  };
  const commandById = new Map<string, string>();
  const texts: string[] = [];

  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") {
      s.availableSkills = asArray(e.skills).filter((x): x is string => typeof x === "string");
    } else if (e.type === "assistant") {
      for (const b of contentOf(e)) {
        if (b.type === "text") texts.push(asString(b.text));
        if (b.type !== "tool_use") continue;
        const input = isObject(b.input) ? b.input : {};
        const name = asString(b.name);
        s.toolUses.push({ name, input });
        if (name === "Skill") s.skillsUsed.push(asString(input.skill));
        if (name === "Bash") {
          const command = asString(input.command);
          s.bashCommands.push(command);
          commandById.set(asString(b.id), command);
        }
      }
    } else if (e.type === "user") {
      for (const b of contentOf(e)) {
        if (b.type !== "tool_result" || b.is_error !== true) continue;
        const command = commandById.get(asString(b.tool_use_id));
        if (command === undefined) continue;
        const text = toolResultText(b);
        if (text.includes("has been denied")) s.denied.push(command);
        else if (text.includes("requires approval")) s.neededApproval.push(command);
      }
    } else if (e.type === "result") {
      s.resultSubtype = asString(e.subtype);
      s.finished = e.subtype === "success";
      s.finalText = asString(e.result);
      if (typeof e.num_turns === "number") s.numTurns = e.num_turns;
      s.permissionDenials = asArray(e.permission_denials).filter(isObject).map((d) => {
        const input = isObject(d.tool_input) ? d.tool_input : {};
        return { tool: asString(d.tool_name), ...(typeof input.command === "string" ? { command: input.command } : {}) };
      });
    }
  }
  s.assistantText = texts.join("\n");
  return s;
}
