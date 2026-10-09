# Contributing

Thanks for helping improve Readlater.

## Before opening a pull request

1. Keep changes focused and explain the user-visible behavior they affect.
2. Do not include `.env`, saved articles, downloaded media, worker logs, tokens, or production URLs.
3. Add or update tests for parsing, anchoring, persistence, or API behavior.
4. Run:

```bash
pnpm test
node --check server.mjs
node --check public/app.js
node --check extension/content-script.js
node --check extension/content-normalization.js
```

For UI changes, also run the relevant checks in `TESTING.md` and describe the browser and viewport used.
