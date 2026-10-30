// The weekly issue through the GitHub REST API. The token (the Actions `GITHUB_TOKEN`, `issues: write`) travels only in
// the Authorization header and never reaches a message.
//   https://docs.github.com/en/rest/issues/issues
import type { Fetch } from "../queue/types.ts";

export class GithubError extends Error {}

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
   * One issue per title. It looks among the issues that carry the label, because the listing is consistent right
   * after a write and the search index is not (a quick second run would create a duplicate). Pull requests, which
   * this endpoint also returns, are skipped.
   */
  async upsert(title: string, body: string, label: string): Promise<{ action: "created" | "updated"; number: number; url: string }> {
    const list = (await this.call("GET", `/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`)) as { number: number; title: string; pull_request?: unknown }[];
    const found = list.find((i) => !i.pull_request && i.title === title);
    const sent = (found
      ? await this.call("PATCH", `/issues/${found.number}`, { body })
      : await this.call("POST", "/issues", { title, body, labels: [label] })) as { number?: number; html_url?: string } | null;
    return { action: found ? "updated" : "created", number: sent?.number ?? found?.number ?? 0, url: sent?.html_url ?? "" };
  }
}
