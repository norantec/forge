---
name: forge-develop-test
description: Develop and test Forge in this repository — build/lint iteration, minimal repro harnesses, and the omni-api end-to-end acceptance run. Use when implementing or verifying changes to src/, or when asked to test forge behavior.
---

# Forge Develop & Test

## Development loop

- Build: `npm run build` (`rimraf dist && tsc`; `dist/` is gitignored and regenerated on demand).
- Lint/format: `npx eslint src/forge.ts`; run `npx eslint --fix` to apply prettier formatting, then re-run lint.
- This repo has no unit tests (`npm test` is a stub). Correctness is verified by integration runs.

## Testing

Use two levels, fastest first:

1. **Minimal repro** — for a focused behavior, create a temp project under `/tmp` with a tsconfig, an entry file, and a small runner that instantiates `Forge` from `dist/forge.js` (or invoke `node dist/cli.js`). Copy the packages under test into the temp project's `node_modules`. Assert on the build log, the bundle text, and running the bundle.
2. **Full consumer E2E** — the acceptance run against omni-api. Automate build + deploy + consumer-build + server check with `scripts/e2e-omni.sh`, or follow [references/omni-api-e2e.md](references/omni-api-e2e.md) manually.

## Non-obvious invariants

- The consumer resolves forge from its own `node_modules` copy, not this repo. After changing `src/`, always rebuild and redeploy `dist/`; back up the old one with `mv` to a `/tmp` dir first so the deploy stays recoverable.
- If forge code needs a new npm package, the consumer's forge install has its own `node_modules` and cannot see forge's. Prefer avoiding new runtime dependencies; if one is unavoidable, install it into the consumer's forge install too.
- `@types/node` is 18 while the runtime is Node 24: newer APIs (e.g. `require.resolve` options `conditions`) are not typed — cast the options/function rather than fighting the types.
- The omni-api bundle is a long-running Nest server and never exits on its own. Success means it starts, logs `Listening on port: 3000`, and serves `/uptime` with HTTP 200; then stop it (Ctrl-C, or the script's kill). A non-zero exit caused by stopping it is expected, not a failure.
