// Builds the preview artifact: for each week, manifest.json, index.html and only the files the manifest cites
// (the working folder also holds intermediate files that must not be uploaded or queued).
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { citedFiles } from "../render/preview.ts";
import { manifestSchema, type Manifest } from "../render/manifest.ts";

export type PackResult = { packed: { week: string; manifest: Manifest }[]; missing: string[] };

export function packArtifact(outRoot: string, weeks: string[], dest: string): PackResult {
  const result: PackResult = { packed: [], missing: [] };
  for (const week of weeks) {
    const from = join(outRoot, week);
    let manifest: Manifest;
    try {
      const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(join(from, "manifest.json"), "utf8")));
      if (!parsed.success) throw new Error("invalid manifest");
      manifest = parsed.data;
    } catch {
      result.missing.push(week);
      continue;
    }
    const to = join(dest, week);
    const copy = (file: string) => {
      const src = join(from, file);
      // Regular files only: the manifest schema already limits the paths to <post>/<account>/<name>.
      if (!existsSync(src) || !lstatSync(src).isFile()) return;
      mkdirSync(dirname(join(to, file)), { recursive: true });
      copyFileSync(src, join(to, file));
    };
    for (const file of citedFiles(manifest)) copy(file);
    copy("manifest.json");
    copy("index.html");
    result.packed.push({ week, manifest });
  }
  return result;
}
