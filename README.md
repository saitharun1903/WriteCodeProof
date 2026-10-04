# WriteCode Proof

Every pull request gets a Proof Pack: the repo's own tests run on old and new code, generated tests for each changed function, a behaviour diff, a Semgrep + Gitleaks scan, and a 0–10 risk score with the reason behind it.

The full spec is in [WRITECODE_PROOF_SPEC.md](WRITECODE_PROOF_SPEC.md).

## Status

| Phase | What                                     | State   |
| ----- | ---------------------------------------- | ------- |
| 1     | Skeleton: workspaces, config, infra      | Done    |
| 2     | Diff + changed-function detection        | Done    |
| 3     | Docker sandbox runner                    | Next    |
| 4     | Checks (tests, security, behaviour, gen) | Pending |
| 5     | Risk score + CLI                         | Pending |
| 6     | GitHub App                               | Pending |
| 7     | Dashboard                                | Pending |
| 8     | Hardening                                | Pending |

## Requirements

- Windows 10/11, macOS or Linux
- Node.js 20.12 or newer
- Git
- Docker Desktop (WSL2 backend on Windows)
- Ollama, for local LLM use (from Phase 4)

## Setup

```bash
npm install
cp .env.example .env
```

Open `.env` and set `POSTGRES_PASSWORD` to any password you like, then put the same password into `DATABASE_URL`. Docker Compose won't start without it.

```bash
npm run infra:up
```

This starts Postgres on `127.0.0.1:5433` and Redis on `127.0.0.1:6380`, then waits until both report healthy. The ports aren't the usual ones on purpose, so they won't clash with anything else you're running.

## Commands

| Command              | Does                                   |
| -------------------- | -------------------------------------- |
| `npm test`           | Run all tests (no build needed)        |
| `npm run build`      | Compile every package to `dist/`       |
| `npm run lint`       | ESLint                                 |
| `npm run format`     | Prettier                               |
| `npm run infra:up`   | Start Postgres + Redis                 |
| `npm run infra:down` | Stop them (data stays in the volumes)  |
| `npm run infra:logs` | Follow their logs                      |
| `npm run examples`   | Build the sample repos in `.examples/` |

## Layout

```
packages/
  core/   engine shared by the CLI and the worker (config lives here)
  cli/    the `writecode-proof` command
  api/    Fastify server: /health now; /webhook and /api/runs later
examples/ sample projects, each as base/ and pr/ snapshots
scripts/  dev helpers (example-repo.mjs turns a sample into a git repo)
tests/    checks that span the whole repo
```

`packages/worker` and `packages/dashboard` get added in Phases 6 and 7.

## Configuration

Every setting comes from the environment. `.env.example` lists them all with comments. Default values are kept in one file, [`packages/core/src/config/defaults.ts`](packages/core/src/config/defaults.ts), and nowhere else.

Settings are checked at startup. If one is wrong, the process stops and tells you which key is the problem:

```
Invalid configuration:
  - PORT: Invalid input: expected number, received NaN
```

The config looks for `.env` in the current folder and then in each parent folder. To use a different file, set `ENV_FILE=path/to/file`.

If you add a setting, add it to `.env.example` as well. A test fails if you forget.

## How changes are detected

`collectChanges()` in `packages/core` works out what a change touched:

1. Finds the merge-base of the base ref (default `main`) and the head, so commits that landed on `main` after the branch was cut are not counted as part of the change.
2. Runs `git diff --unified=0` against it. Head is either a ref or the working tree; the working tree includes uncommitted edits and new untracked files.
3. Parses both versions of each changed file with tree-sitter (WebAssembly build, so nothing gets compiled on install) and lists every function and method.
4. Maps each changed line to the innermost function around it. A function that only exists on the new side is `added`, only on the old side `deleted`, otherwise `modified`.

Supported: `.js .mjs .cjs .jsx .ts .mts .cts .tsx .py`.

Skipped, with the reason recorded: docs, lockfiles, build output, generated code, test files, binaries, submodules, symlinks, and files over 1 MB. The full ignore list is `ANALYSIS_DEFAULTS.IGNORE` in [defaults.ts](packages/core/src/config/defaults.ts); more globs can be passed per run.

## Sample repos

`examples/js-sample` and `examples/py-sample` are small shopping-cart modules. Each has a `base/` version and a `pr/` version with planted bugs:

- `cheapestItem` / `cheapest_item` drops its empty-list guard and now crashes on `[]`
- `roundMoney` / `round_money` truncates instead of rounding (1.999 becomes 1.99, not 2.00)
- one function added, one deleted, and `Cart.add` changed to merge duplicate items

`npm run examples` turns them into real git repos under `.examples/` (main = base, with the PR as uncommitted changes). Add `--branch` to the script to commit the PR on a `pr` branch instead.

## Verifying Phase 1

```bash
npm install
npm test
npm run build
node packages/cli/dist/index.js --version
npm run infra:up
docker compose ps
```

You should see all tests passing, the CLI printing `0.1.0`, and both containers showing `healthy`.

To check the API:

```bash
node packages/api/dist/index.js
```

Then open http://127.0.0.1:3100/health in a browser.

## Verifying Phase 2

```bash
npm test
```

`tests/changes.test.ts` builds both sample repos and checks the exact list of changed functions, in working-tree and branch mode. To see the output yourself:

```bash
npm run build
npm run examples
node --input-type=module -e "import { collectChanges } from './packages/core/dist/index.js'; const c = await collectChanges({ repoPath: '.examples/js-sample' }); console.table(c.changedFunctions.map(({ status, file, qualifiedName, signature }) => ({ status, file, qualifiedName, signature })))"
```
