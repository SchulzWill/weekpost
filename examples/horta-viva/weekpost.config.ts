// Example project: a fictional urban garden brand with two accounts.
import { defineConfig, ideasFile } from "weekpost";

export default defineConfig({
  brand: {
    name: "Horta Viva",
    colors: {
      primary: "#2F6B3A",
      dark: "#173A20",
      bg: "#F7F4EA",
      fg: "#141A14",
      muted: "#5B6157",
      tint: "#E3EFE0",
      onDark: "#E6F2E3",
      onDarkMuted: "#C2D8BD",
    },
    font: { family: "Inter", files: { 400: "assets/fonts/inter-400.woff2", 800: "assets/fonts/inter-800.woff2" } },
    logo: { file: "assets/logo.svg", recolor: { primary: "#2F6B3A", fg: "#141A14" } },
  },
  media: { visionHint: "plants, urban gardens, pots and kitchen produce" },
  accounts: {
    en: {
      handle: "hortaviva.en",
      lang: "en",
      timeZone: "Europe/London",
      hemisphere: "north",
      voice: "george",
      cta: ["link in bio"],
      link: { base: "https://hortaviva.example/en/" },
    },
    "pt-br": {
      handle: "hortaviva.br",
      lang: "pt-BR",
      timeZone: "America/Sao_Paulo",
      hemisphere: "south",
      voice: "sarah",
      cta: ["link na bio"],
      link: { base: "https://hortaviva.example/br/" },
    },
  },
  pillars: ["tip", "recipe", "other"],
  sources: [ideasFile({ path: "ideas.md" })],
  reel: { maxSeconds: 90 },
  budget: { weeklyUsd: 5 },
});
