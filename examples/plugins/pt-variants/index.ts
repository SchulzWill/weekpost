// Example lint plugin: keeps European and Brazilian Portuguese vocabulary from mixing in one account.
// It is not loaded by default. Copy it into your project and add it to weekpost.config.ts:
//
//   import ptVariants from "./plugins/pt-variants/index.ts";
//   export default defineConfig({ ..., lint: { plugins: [ptVariants] } });
//
// The word lists are short on purpose; extend them with the words your content uses.
import type { LintPlugin } from "weekpost";

// [pt-PT, pt-BR]
const PAIRS: [string, string][] = [
  ["autocarro", "ônibus"],
  ["comboio", "trem"],
  ["carta de condução", "carteira de motorista"],
  ["rapariga", "moça"],
  ["sumo", "suco"],
  ["telemóvel", "celular"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole word, accents included (\b does not recognize accented letters).
const word = (w: string) => new RegExp(`(?<![\\p{L}\\d])${escapeRe(w).replace(/ /g, "\\s+")}(?![\\p{L}\\d])`, "iu");

// "estou a fazer" is European Portuguese; Brazilian Portuguese uses the gerund ("estou fazendo").
const PROGRESSIVE_PT = /(?<![\p{L}\d])(?:estou|estás|está|estamos|estão|estava|estavam)\s+a\s+\p{L}+r(?![\p{L}\d])/iu;

const ptVariants: LintPlugin = {
  name: "pt-variants",
  lintText(text, field, ctx) {
    const lang = ctx.lang.toLowerCase();
    if (lang !== "pt-pt" && lang !== "pt-br") return [];
    const where = ""; // empty: the check fills in "<post id> <account> <field>"
    const issues = [];
    // Words of the other variant are the ones to flag.
    for (const [european, brazilian] of PAIRS) {
      const [foreign, local] = lang === "pt-br" ? [european, brazilian] : [brazilian, european];
      if (word(foreign).test(text)) {
        issues.push({ level: "error" as const, where, message: `"${foreign}" is ${lang === "pt-br" ? "European" : "Brazilian"} Portuguese; use "${local}" in ${ctx.lang}` });
      }
    }
    if (lang === "pt-br" && PROGRESSIVE_PT.test(text)) {
      issues.push({ level: "error" as const, where, message: 'use the gerund in pt-BR ("estou fazendo"), not "estar a + infinitive"' });
    }
    return issues;
  },
};

export default ptVariants;
