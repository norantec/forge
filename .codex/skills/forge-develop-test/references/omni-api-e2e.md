# omni-api end-to-end acceptance

Goal: prove a forge change bundles and runs in the real consumer (`../omni-api`).

## Automated

From the forge repo root run `scripts/e2e-omni.sh`. It:

1. builds forge (`npm run build`);
2. backs up and replaces `../omni-api/node_modules/@open-norantec/forge/dist`;
3. builds omni-api (`npm run build`);
4. starts `node ./dist/main.js`, waits for HTTP 200 on `http://127.0.0.1:3000/uptime`, then stops the server.

Exit 0 means accepted. Use `TEST_PORT` if the app listens elsewhere.

## Manual

1. `cd forge && npm run build`
2. Backup and replace the consumer dist:

   ```sh
   backup=$(mktemp -d /tmp/forge-omni-backup-XXXXXX)
   mv ../omni-api/node_modules/@open-norantec/forge/dist "$backup/dist"
   cp -R dist ../omni-api/node_modules/@open-norantec/forge/dist
   ```

3. `cd ../omni-api && npm run build` — expect `Generated file: .../dist/main.js` and no `error` lines.
4. `node ./dist/main.js` — expect Nest startup logs and `Listening on port: 3000`; verify `curl http://127.0.0.1:3000/uptime` returns 200, then press Ctrl-C.

## Bundle assertions (for bundleDependencies changes)

- No unresolved package imports left in the bundle: `rg -c '#crypto' dist/main.js` finds nothing.
- Previously external packages are inlined: markers such as `createUnauthenticatedAuth` (`@octokit/auth-unauthenticated`) or `createPrivateKey` (universal-github-app-jwt `node` condition target) appear in `dist/main.js`.
- The build log contains no `[EXTERNAL]` entries for packages that must be bundled.
