# Contributing

weekpost is pre-alpha: interfaces and file formats can still change, so expect rough edges.

- Issues are welcome: bug reports, questions and ideas.
- Pull requests from outside go through the maintainer's review, and may be declined or reshaped. For anything larger than a small fix, open an issue first.
- Before opening a PR, run `npm run verify` (typecheck, tests, lint). If you touch SQL, also run `npm run test:db` against a throwaway Postgres (see `packages/weekpost/src/queue/sql.test.ts`).
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).
