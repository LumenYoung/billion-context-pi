# Maintain Pi Git installations

This workflow applies to the maintained `LumenYoung/billion-context-pi` fork.
Git release commits must include the complete prebuilt `dist/` directory; Pi
loads `dist/index.js`, not the TypeScript sources.

## Installation contract

Pi omits development dependencies when installing Git packages. The tested
Pi 0.99.1 installer uses `npm install --omit=dev --legacy-peer-deps`; older
hosts may omit the peer-suppression flag. An unconditional build in `prepare` cannot work under those options: `tsup`,
TypeScript, and the bundled `acp-kernel` are development dependencies, while
`typebox` is a peer dependency that the build also bundles.

The prepare script uses prebuilt artifacts when `npm_config_omit` contains `dev`
or `NODE_ENV` is `production`. It checks that `dist/index.js`, `dist/contract.js`,
`dist/index.d.ts`, and `dist/contract.d.ts` are readable, without invoking the
compiler. It also imports the host-independent contract to validate its shared
runtime chunk. Missing or invalid artifacts fail installation with guidance to
use a maintained release commit or build with development and peer dependencies
installed. Other installations run `npm run build` and propagate build failures.

The import does not exercise the full extension or establish artifact freshness.
CI tests the committed production install before rebuilding, then rejects tracked
changes and untracked output under `dist/`. LF checkout rules for sources and
artifacts keep the comparison stable across platforms. Publish the entire build
output, including chunks, declarations, and source maps. Pi supplies the external
host packages at runtime.

## Prepare a release commit

Use Node.js 22.19.0 or later, compatible with the development Pi dependency. From the development checkout, with `NODE_ENV` unset
and development dependencies not omitted, run:

```bash
npm install --include=dev --include=peer --legacy-peer-deps=false
npm run test:packaging
npm run typecheck
npm test
npm run build
```

Development installation also builds through `prepare`. Regenerate and commit
`dist/` alongside source or build-configuration changes before publishing a Git
release commit. Keep `package.json` and `package-lock.json` synchronized and
preserve the exact `acp-kernel` pin. Review the complete diff and follow the
repository's issue, PR, and human-only merge requirements.

## Verify a clean production installation

Test the candidate commit in a fresh checkout, without existing `node_modules`
or locally generated artifacts. Set `RELEASE_COMMIT` to its full published SHA:

```bash
git clone git@github.com:LumenYoung/billion-context-pi.git acp-install-check
cd acp-install-check
git checkout --detach "$RELEASE_COMMIT"
npm install --omit=dev --legacy-peer-deps
```

Expect `Using prebuilt dist artifacts for production installation.` and no
compiler invocation. Confirm `dist/index.js` exists, then test the commit through
Pi's managed installer and a fresh runtime. Installation success alone does not
establish ACP or paired Advisor runtime acceptance.

Commit-pinned deployments advance only when their configured full SHA is
explicitly changed; routine updates do not select a newer release commit.
Publishing a fork commit is not an upstream merge or an npm release.
