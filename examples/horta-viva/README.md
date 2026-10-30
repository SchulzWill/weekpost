# Horta Viva

A fictional urban garden brand used to try weekpost without any setup. Nothing here is a real brand.

- `weekpost.config.ts`: two accounts (`en` in Europe/London, `pt-br` in America/Sao_Paulo).
- `content/2026-W45/posts.yaml`: one carousel (both accounts), one Story, one 15 s Reel and one 60 s weekly recap Reel with 8 segments (no music, catalog voice). The config sets `reel.maxSeconds: 90` so the recap passes the lint.
- `ideas.md`: five garden ideas read by the `ideasFile` source (`npx weekpost sources pull 2026-W45 --project=examples/horta-viva`). The date of each idea is the commit of its line, so an idea you add must be committed first.
- `assets/logo.svg`: a made-up logo.
- `assets/fonts/`: Inter 400 and 800 ([rsms/inter](https://github.com/rsms/inter), release 4.0, `web/Inter-Regular.woff2` and `web/Inter-ExtraBold.woff2`). Licensed under the SIL Open Font License 1.1, see `assets/fonts/OFL.txt`.

```sh
npx weekpost generate 2026-W45 --project=examples/horta-viva --fake-media
```

`--fake-media` swaps image generation, narration and the vision check for local placeholders, so it needs no API key and costs nothing. The output goes to `examples/horta-viva/out/2026-W45/` (git-ignored); open `index.html` there for the preview.
