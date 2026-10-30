// Week preview page (out/<week>/index.html): a grid per post and account, audio, cost, lint warnings and the
// image-versus-text "review" flags. Relative paths, so the page opens locally and from any static host.
// The interface is in English; captions and texts stay in each account's language.
import { esc } from "./brand.ts";
import type { Manifest } from "./manifest.ts";

/** What the page needs from the config to label an account. */
export type PreviewAccounts = Record<string, { handle: string; lang: string }>;

/** Files of the week folder the page cites (media, video posters and audio), relative to the folder. */
export function citedFiles(m: Manifest): Set<string> {
  const out = new Set<string>();
  const add = (raw: string) => {
    const f = raw;
    out.add(f);
    if (f.endsWith(".mp4")) out.add(f.replace(/\.mp4$/, ".jpg"));
  };
  for (const p of m.posts) {
    for (const a of Object.values(p.accounts)) {
      a.files.forEach(add);
      a.publish.forEach(add);
      if (a.audio) add(a.audio);
      if (a.cover) add(a.cover);
    }
  }
  return out;
}

function media(file: string, label: string, publish: string[] = []) {
  // Video poster: frame extracted by generate next to the MP4 (same name, .jpg).
  if (file.endsWith(".mp4")) {
    const name = file.split("/").pop()!.replace(/\.mp4$/, "") + (publish.includes(file) ? " · publishes" : "");
    return `<figure><video controls preload="none" poster="${esc(file.replace(/\.mp4$/, ".jpg"))}" src="${esc(file)}" aria-label="${esc(label)} ${esc(name)}"></video><figcaption>${esc(name)}</figcaption></figure>`;
  }
  return `<a href="${esc(file)}" target="_blank"><img loading="lazy" src="${esc(file)}" alt="${esc(label)}"></a>`;
}

export function previewHtml(m: Manifest, labels: PreviewAccounts = {}): string {
  const posts = m.posts
    .map((p) => {
      const review = p.coherence.filter((c) => !c.shows);
      const flags = review.length
        ? `<ul class="review">${review.map((c) => `<li><strong>Review</strong> image ${c.index + 1}: ${esc(c.reason)}</li>`).join("")}</ul>`
        : "";
      const accounts = Object.entries(p.accounts)
        .map(
          ([acc, a]) => `<div class="acc" lang="${esc(labels[acc]?.lang ?? "")}"><h3>@${esc(labels[acc]?.handle ?? acc)} · ${esc(p.times[acc] ?? "")}${p.timeZones[acc] ? ` (${esc(p.timeZones[acc])})` : ""}</h3>
<div class="grid">${a.cover ? `<figure>${media(a.cover, `${p.id} ${acc} cover`)}<figcaption>cover</figcaption></figure>` : ""}${a.files.map((f, i) => media(f, `${p.id} ${acc} ${i + 1}`, a.publish)).join("")}</div>
${a.audio ? `<audio controls preload="none" src="${esc(a.audio)}"></audio>` : ""}
${a.music ? `<p class="music">Music: ${esc(a.music)}</p>` : ""}
<pre class="caption">${esc(a.caption)}</pre></div>`,
        )
        .join("");
      return `<section><h2>${esc(p.date)} · ${esc(p.type)} · <code>${esc(p.id)}</code></h2>${p.error ? `<p class="error" role="alert">${esc(p.error)}</p>` : ""}${flags}${accounts}</section>`;
    })
    .join("");
  const warnings = m.warnings.length
    ? `<section><h2>Lint warnings</h2><ul>${m.warnings.map((w) => `<li><code>${esc(w.where)}</code>: ${esc(w.message)}</li>`).join("")}</ul></section>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview ${esc(m.week)}</title><style>
:root{--bg:#F5F5F5;--fg:#1A1A1A;--muted:#5F5F5F;--card:#FFFFFF;--border:#DADADA;--primary:#3A3A3A;--warn-bg:#FFF1CC;--warn-fg:#6B4A00;--danger:#FDE4E1}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#EDEDED;--muted:#A8A8A8;--card:#1B1B1B;--border:#333333;--primary:#CFCFCF;--warn-bg:#3A2E12;--warn-fg:#F2D49A;--danger:#3A1F1A}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
h1{margin:0 0 4px}section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin:16px 0}
.grid{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px}.grid img,.grid video{height:320px;width:auto;border-radius:6px;display:block}
figure{margin:0}figcaption{font-size:13px;color:var(--muted);margin-top:4px}.acc{margin-top:12px}.acc h3{margin:0 0 8px;font-size:15px}
.caption{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.4 ui-monospace,monospace;background:var(--bg);padding:8px;border-radius:6px}
.review{background:var(--warn-bg);color:var(--warn-fg);padding:8px 8px 8px 28px;border-radius:8px}
.error{background:var(--danger);padding:8px;border-radius:8px}audio{width:100%;max-width:480px}
a:focus-visible{outline:3px solid var(--primary);outline-offset:2px}
</style></head><body>
<h1>Preview ${esc(m.week)}</h1>
<p>Week cost: <strong>US$${m.spentUsd.toFixed(2)} of US$${m.budgetUsd}</strong>. Illustrative images are AI-generated, except the real cover photo (when there is one).</p>
${warnings}${posts}
</body></html>`;
}
