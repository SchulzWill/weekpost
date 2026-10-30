import { describe, expect, it } from "vitest";
import { remoteActions } from "./remote.ts";
import { probe } from "./probes.ts";
import { stepsFor, type SetupContext } from "./steps.ts";
import type { ApplyIO } from "./apply.ts";
import type { Runner } from "./runner.ts";

type Policy = { id: number; name: string; type?: string };

/** A fake `gh`: one environment with a list of branch policies; records every call. */
function fakeGh(initial: Policy[], opts: { secrets?: string[] } = {}) {
  let policies = [...initial];
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    if (cmd === "gh" && args[0] === "secret" && args[1] === "list") return ok(JSON.stringify((opts.secrets ?? ["WEEKPOST_SUPABASE_URL", "WEEKPOST_SUPABASE_KEY"]).map((name) => ({ name }))));
    if (cmd === "gh" && args[0] === "secret" && args[1] === "set") return ok("");
    if (cmd === "gh" && args[0] === "api") {
      const method = args[1] === "-X" ? args[2]! : "GET";
      const path = args.find((a) => a.startsWith("repos/"))!;
      if (path.endsWith("/deployment-branch-policies") && method === "GET") return ok(JSON.stringify({ total_count: policies.length, branch_policies: policies }));
      if (path.endsWith("/deployment-branch-policies") && method === "POST") {
        policies.push({ id: 900 + policies.length, name: "main", type: "branch" });
        return ok("{}");
      }
      const del = /deployment-branch-policies\/(\d+)$/.exec(path);
      if (del && method === "DELETE") {
        policies = policies.filter((p) => p.id !== Number(del[1]));
        return ok("");
      }
      if (method === "PUT") return ok("{}");
      return ok(JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }));
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls, names: () => policies.map((p) => p.name) };
}

const ctxWith = (run: Runner): SetupContext => ({
  projectRoot: "/x", project: "x", accounts: [], previewLabel: "media-ok", bucket: "b", latestSchema: 3, localEnvFile: "/x/.env",
  supabase: { url: "https://a.example.test", key: "k" }, env: {}, run, fetch: (async () => new Response("{}")) as never, hasChromium: async () => true,
});

function ioFor(ctx: SetupContext, answer: boolean) {
  const lines: string[] = [];
  const asked: string[] = [];
  const io: ApplyIO = {
    out: { log: (l) => lines.push(l), error: (l) => lines.push(l) },
    secret: async (n) => (n === "WEEKPOST_SUPABASE_URL" ? "https://a.example.test" : "SENTINEL-key"),
    context: () => ctx,
    options: {},
    confirm: async (q) => (asked.push(q), answer),
  };
  return { io, lines, asked };
}

describe("github.environment: branch policies", () => {
  it("the probe is ok when main is the only policy", async () => {
    const gh = fakeGh([{ id: 1, name: "main", type: "branch" }]);
    expect((await probe(ctxWith(gh.run), "github.environment")).state).toBe("ok");
  });
  it("the probe fails (todo) when an older policy lets another branch deploy, without naming it", async () => {
    const gh = fakeGh([{ id: 1, name: "main", type: "branch" }, { id: 2, name: "content/*", type: "branch" }]);
    const r = await probe(ctxWith(gh.run), "github.environment");
    expect(r.state).toBe("todo");
    expect(r.detail).toMatch(/other branch/);
    expect(r.detail).not.toContain("content/*");
  });
  it("the probe fails when main is not listed at all", async () => {
    const gh = fakeGh([{ id: 2, name: "*", type: "branch" }]);
    expect((await probe(ctxWith(gh.run), "github.environment")).state).toBe("todo");
  });
  it("--apply shows the other policies, asks, and deletes them", async () => {
    const gh = fakeGh([{ id: 1, name: "main", type: "branch" }, { id: 2, name: "*", type: "branch" }]);
    const ctx = ctxWith(gh.run);
    const { io, lines, asked } = ioFor(ctx, true);
    await remoteActions["github.environment"]!(io, stepsFor(ctx)[0]!);
    expect(gh.names()).toEqual(["main"]);
    expect(asked).toHaveLength(1);
    expect(lines.join("\n")).toContain("*");
  });
  it("--apply stops and changes nothing when the other policies are not confirmed", async () => {
    const gh = fakeGh([{ id: 2, name: "content/*", type: "branch" }]);
    const ctx = ctxWith(gh.run);
    const { io } = ioFor(ctx, false);
    await expect(remoteActions["github.environment"]!(io, stepsFor(ctx)[0]!)).rejects.toThrow(/branch polic/);
    expect(gh.names()).toEqual(["content/*"]);
    expect(gh.calls.some((c) => c.includes("secret set"))).toBe(false);
  });
});

describe("step order", () => {
  it("writes the local secrets file right after the bucket, before the GitHub steps", () => {
    const ids = stepsFor(ctxWith(fakeGh([]).run)).map((s) => s.id);
    expect(ids.indexOf("local.secrets")).toBe(ids.indexOf("storage.bucket") + 1);
  });
});
