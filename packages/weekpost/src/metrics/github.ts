// The weekly issue and the Story reminders through the GitHub REST API. The token (the Actions `GITHUB_TOKEN`, `issues: write`) travels only in
// the Authorization header and never reaches a message.
//   https://docs.github.com/en/rest/issues/issues
import type { Fetch } from "../queue/types.ts";

/** The label of the Story reminder issues. */
export const STORY_LABEL = "story";

export class GithubError extends Error {}

export type IssueInfo = { number: number; title: string; state: "open" | "closed"; url: string };

export class GithubIssues {
  constructor(
    private readonly fetchFn: Fetch,
    private readonly repo: string,
    private readonly token: string,
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new GithubError("the repository must look like owner/name (set GITHUB_REPOSITORY or pass --repo)");
    if (!token.trim()) throw new GithubError("GITHUB_TOKEN is not set");
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.github.com/repos/${this.repo}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "weekpost",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GithubError(`GitHub ${method} ${path.split("?")[0]} -> network error`);
    }
    const text = await res.text();
    if (!res.ok) {
      const msg = (() => {
        try {
          return String((JSON.parse(text) as { message?: string }).message ?? "");
        } catch {
          return "";
        }
      })();
      throw new GithubError(`GitHub ${method} ${path.split("?")[0]} -> ${res.status}${msg ? `: ${msg.slice(0, 120)}` : ""}`.split(this.token).join("[token]"));
    }
    return text ? JSON.parse(text) : null;
  }

  /**
   * The issues that carry the label (pull requests, which this endpoint also returns, are skipped), newest first. The
   * listing is consistent right after a write and the search index is not, so a quick second run still sees what the
   * first one created. It follows the pages until one comes back short.
   */
  async list(label: string, state: "open" | "closed" | "all" = "all"): Promise<IssueInfo[]> {
    const found: IssueInfo[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = (await this.call("GET", `/issues?labels=${encodeURIComponent(label)}&state=${state}&per_page=100&page=${page}`)) as { number: number; title: string; state?: string; html_url?: string; pull_request?: unknown }[];
      found.push(...batch.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state === "closed" ? ("closed" as const) : ("open" as const), url: i.html_url ?? "" })));
      if (batch.length < 100) break;
    }
    return found;
  }

  async create(title: string, body: string, label: string): Promise<{ number: number; url: string }> {
    const sent = (await this.call("POST", "/issues", { title, body, labels: [label] })) as { number?: number; html_url?: string } | null;
    return { number: sent?.number ?? 0, url: sent?.html_url ?? "" };
  }

  /** Closes an issue, with an optional last comment saying why. */
  async close(number: number, comment?: string): Promise<void> {
    if (comment) await this.call("POST", `/issues/${number}/comments`, { body: comment });
    await this.call("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" });
  }

  /** One issue per title, looked up among the issues that carry the label. */
  async upsert(title: string, body: string, label: string): Promise<{ action: "created" | "updated"; number: number; url: string }> {
    const found = (await this.list(label)).find((i) => i.title === title);
    if (!found) return { action: "created", ...(await this.create(title, body, label)) };
    const sent = (await this.call("PATCH", `/issues/${found.number}`, { body })) as { number?: number; html_url?: string } | null;
    return { action: "updated", number: sent?.number ?? found.number, url: sent?.html_url ?? "" };
  }
}
