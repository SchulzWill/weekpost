# AGENTS.md

Guidance for AI agents and contributors working on weekpost.

## Always

- One focused pull request per change, from an up-to-date `main`.
- Tests run with `TZ=UTC` and never call paid APIs: OpenRouter and the Meta Graph API are always mocked.
- The core (`packages/`) knows no brand. Brands, accounts, voices and brand-voice rules come from configuration or plugins.
- Code, CLI messages and docs are in English.

## Ask first

- New dependencies, changes to the queue schema, or changes to the versioned `posts.yaml` contract.

## Never

- Deploy, write secrets or run DDL outside `weekpost setup --apply` run by a human.
- Commit music, cloned voices, logos or any third-party data. This repo ships no music.
- Print tokens or keys in logs, output or pull requests.
