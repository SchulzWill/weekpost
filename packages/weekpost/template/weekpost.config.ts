// Minimal valid config. Edit it, then add the font and logo files it names under assets/.
import { defineConfig } from "weekpost";

export default defineConfig({
  brand: {
    name: "My App",
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
    logo: { file: "assets/logo.svg" },
  },
  accounts: {
    en: {
      handle: "myapp",
      lang: "en",
      timeZone: "Europe/London",
      hemisphere: "north",
      voice: "george",
      cta: ["link in bio"],
      link: { base: "https://myapp.example/" },
    },
  },
  pillars: ["tip", "story"],
});
