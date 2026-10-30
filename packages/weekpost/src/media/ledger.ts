// Cost log of one week (out/<week>/costs.jsonl) and the weekly spending cap (config.budget.weeklyUsd).
// One ledger per week: every account of the project spends from the same cap.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type LedgerEntry = {
  kind: "image" | "tts" | "vision";
  model: string;
  item: string;
  ok: boolean;
  costUsd: number;
  costSource: "usage" | "generation" | "estimated";
  latencyMs: number;
  error?: string;
  at?: string;
};

export class BudgetError extends Error {}

export class Ledger {
  constructor(readonly file: string, readonly budgetUsd: number) {}

  entries(): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  spent(): number {
    return this.entries().reduce((s, e) => s + e.costUsd, 0);
  }

  assertBudget(nextEstimateUsd: number) {
    const spent = this.spent();
    if (spent + nextEstimateUsd > this.budgetUsd) {
      throw new BudgetError(`weekly budget of US$${this.budgetUsd} reached: spent $${spent.toFixed(4)} + next call ~$${nextEstimateUsd.toFixed(4)}`);
    }
  }

  record(entry: LedgerEntry) {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n");
  }
}
