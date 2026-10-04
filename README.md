# WriteCode Proof

Every pull request gets a Proof Pack: the repo's own tests run on old and new code, generated tests for each changed function, a behaviour diff, a Semgrep + Gitleaks scan, and a 0–10 risk score with the reason behind it.

The full spec is in [WRITECODE_PROOF_SPEC.md](WRITECODE_PROOF_SPEC.md).

## Status

| Phase | What                                     | State   |
| ----- | ---------------------------------------- | ------- |
| 1     | Skeleton: workspaces, config, infra      | Done    |
| 2     | Diff + changed-function detection        | Done    |
| 3     | Docker sandbox runner                    | Done    |
| 4     | Checks (tests, security, behaviour, gen) | Next    |
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

| Command                | Does                                    |
| ---------------------- | --------------------------------------- |
| `npm test`             | Run all tests (no build needed)         |
| `npm run build`        | Compile every package to `dist/`        |
| `npm run lint`         | ESLint                                  |
| `npm run format`       | Prettier                                |
| `npm run infra:up`     | Start Postgres + Redis                  |
| `npm run infra:down`   | Stop them (data stays in the volumes)   |
| `npm run infra:logs`   | Follow their logs                       |
| `npm run examples`     | Build the sample repos in `.examples/`  |
| `npm run build:images` | Build the three sandbox images          |
| `npm run test:sandbox` | Docker tests proving the sandbox limits |

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

## Sandbox

Repository code never runs on your machine directly. Every step runs in a throwaway Docker container built by `buildContainerSpec()` in [spec.ts](packages/core/src/sandbox/spec.ts), which is the only place the limits are set:

| Limit           | Setting                                                   |
| --------------- | --------------------------------------------------------- |
| Network         | none (only a dependency install may turn it on)           |
| CPU             | `SANDBOX_CPUS`, default 1                                 |
| Memory and swap | `SANDBOX_MEMORY`, default 2g                              |
| Processes       | `SANDBOX_PIDS_LIMIT`, default 256                         |
| Filesystem      | read-only, except `/work` and a `/tmp` tmpfs              |
| User            | `SANDBOX_USER`, default 1000:1000; root is refused        |
| Capabilities    | all dropped, no-new-privileges                            |
| Time            | `SANDBOX_STEP_TIMEOUT_S` per step, `RUN_BUDGET_S` per run |

`/work` is the run's own temp folder. The runner refuses to mount anything outside `SANDBOX_WORKDIR_ROOT`, and the only other mounts allowed are Docker volumes named `writecode-proof-*` (for dependency caches). The Docker socket and your home folder are never mounted. Containers are removed after every step, including on timeout or error.

Images, from `sandbox-images/`:

| Image    | Base                     | Extras                                     | Size    |
| -------- | ------------------------ | ------------------------------------------ | ------- |
| `node`   | node 24.21 (Debian slim) | none                                       | ~330 MB |
| `python` | python 3.13.16 (slim)    | pytest 9.1.1                               | ~220 MB |
| `tools`  | semgrep 1.179.0          | gitleaks 8.30.1, Semgrep `p/default` rules | ~1.6 GB |

Scans run offline, so the Semgrep community rules (about 1,000) are downloaded when the tools image is built. Rebuild it to pick up newer rules.

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

## Verifying Phase 3

Docker Desktop must be running.

```bash
npm run build:images
```

```bash
npm run test:sandbox
```

The 12 tests in [sandbox.docker.test.ts](tests/sandbox/sandbox.docker.test.ts) start real containers and check, from inside them: uid 1000 with zero capabilities, no network interface besides `lo` (DNS and HTTP both fail), writes fail everywhere except `/work` and `/tmp`, no Docker socket and no extra mounts, a stuck process is killed at its timeout and its container removed, the memory and process limits kill or block runaway code, and Python, pytest, Semgrep and Gitleaks all work with no network.
