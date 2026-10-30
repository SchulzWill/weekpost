# Cost

Back to the [README](../README.md).

## Cost of running it

- **Media:** see the next section; paid per use through OpenRouter, capped per week.
- **Worker:** one cron every 5 minutes. The free plan allows 5 crons per account and 50 subrequests per run; with the default of 2 posts per run, two carousels of 10 images fit (priced at 20 subrequests each in the worst case: 3 status checks and 2 attempts to record). The publisher counts the real calls before claiming, so when a token renewal takes part of the budget it claims fewer posts and the rest wait for the next run.
- **GitHub Actions minutes:** the check is a few minutes. The preview runs again on every push while the label is on; the media cache avoids paying the media API twice, but a private repository spends minutes each time. Remove the label while you keep editing, add it back for the final preview.
- **Supabase:** media is deleted 7 days after publishing, so storage stays small.

## What a week costs

Media is paid per use through OpenRouter. The numbers below are the estimates weekpost uses when the API does not report a cost; the real figure is written to `out/<week>/costs.jsonl` and to the manifest as `spentUsd`.

| Item | Estimate | When |
|---|---|---|
| Image, `seedream-4.5` (default) | US$0.04 | one per slide, Reel segment or Story image |
| Image, `gpt-image-2` | US$0.005 | same, when a post sets `image_model` |
| Image check (vision judge) | US$0.02 | one per generated image |
| Narration | US$0.00008 | per character of the Reel narration, per account |

Identical prompts and inputs are served from the cache, so re-running a week costs nothing. A weekly cap stops the run when it is reached (`budget.weeklyUsd`, default US$5). In the GitHub workflows the cap is counted per pull request, not per week: each pull request starts a fresh cost record, so N pull requests for the same week can spend up to N times the cap.

Example week (`examples/horta-viva`): 1 carousel with 3 slides, 1 Story and 1 Reel with 3 segments, so 7 images.

```
7 images x US$0.04               = US$0.28
7 image checks x US$0.02         = US$0.14
87 narration characters x 0.00008 = US$0.007
                                   ---------
                                   about US$0.43   (about US$0.18 with gpt-image-2)
```
