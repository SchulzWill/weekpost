// A small unified diff (no dependency): line based, 3 lines of context, for showing how a file you edited differs
// from the one the new version would write.

const CONTEXT = 3;

type Op = { kind: " " | "-" | "+"; text: string };

/** Longest common subsequence of lines; fine for the small text files weekpost generates. */
function ops(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ kind: "-", text: a[i++]! });
    else out.push({ kind: "+", text: b[j++]! });
  }
  while (i < n) out.push({ kind: "-", text: a[i++]! });
  while (j < m) out.push({ kind: "+", text: b[j++]! });
  return out;
}

const lines = (text: string) => {
  const l = text.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
};

/** Unified diff of `current` (the file on disk) against `next` (the file the new version writes). Empty when equal. */
export function unifiedDiff(path: string, current: string, next: string): string {
  if (current === next) return "";
  const all = ops(lines(current), lines(next));
  const changed = all.flatMap((o, k) => (o.kind === " " ? [] : [k]));
  // Group the changes whose context overlaps into one hunk.
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const from = Math.max(0, k - CONTEXT);
    const to = Math.min(all.length, k + CONTEXT + 1);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1]) last[1] = to;
    else hunks.push([from, to]);
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const [from, to] of hunks) {
    const before = all.slice(0, from);
    const slice = all.slice(from, to);
    const oldStart = before.filter((o) => o.kind !== "+").length + 1;
    const newStart = before.filter((o) => o.kind !== "-").length + 1;
    const oldLen = slice.filter((o) => o.kind !== "+").length;
    const newLen = slice.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${oldLen ? oldStart : oldStart - 1},${oldLen} +${newLen ? newStart : newStart - 1},${newLen} @@`);
    for (const o of slice) out.push(`${o.kind}${o.text}`);
  }
  return out.join("\n");
}
