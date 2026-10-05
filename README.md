# WriteCode Proof

Every pull request gets a Proof Pack: the repo's own tests run on old and new code, generated tests for each changed function, a behaviour diff, a Semgrep + Gitleaks scan, and a 0–10 risk score with the reason behind it.

The full spec is in [WRITECODE_PROOF_SPEC.md](WRITECODE_PROOF_SPEC.md).

## Status

| Phase | What                                     | State                             |
| ----- | ---------------------------------------- | --------------------------------- |
| 1     | Skeleton: workspaces, config, infra      | Done                              |
| 2     | Diff + changed-function detection        | Done                              |
| 3     | Docker sandbox runner                    | Done                              |
| 4     | Checks (tests, security, behaviour, gen) | Done                              |
| 5     | Risk score + CLI                         | Done                              |
| 6     | GitHub App                               | Done (needs your app to try live) |
| 7     | Dashboard                                | Done                              |
| 8     | Hardening                                | Done                              |

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

| Command                 | Does                                             |
| ----------------------- | ------------------------------------------------ |
| `npm test`              | Run all tests (no build needed)                  |
| `npm run build`         | Compile every package to `dist/`                 |
| `npm run lint`          | ESLint                                           |
| `npm run format`        | Prettier                                         |
| `npm run infra:up`      | Start Postgres + Redis                           |
| `npm run infra:down`    | Stop them (data stays in the volumes)            |
| `npm run infra:logs`    | Follow their logs                                |
| `npm run examples`      | Build the sample repos in `.examples/`           |
| `npm run build:images`  | Build the three sandbox images                   |
| `npm run test:sandbox`  | Docker tests proving the sandbox limits          |
| `npm run cache:clear`   | Remove cached dependency volumes and LLM replies |
| `npm run dev`           | API + worker + smee.io relay, for the GitHub App |
| `npm run dev:dashboard` | Dashboard with live reload on `DASHBOARD_PORT`   |
| `npm run db:generate`   | New SQL migration after a schema change          |

## Layout

```
packages/
  core/   engine shared by the CLI and the worker (config lives here)
  cli/    the `writecode-proof` command
  api/    Fastify server: /webhook, /api/runs, /health
  db/     Postgres schema, migrations and queries (Drizzle)
  github/ webhooks, the run queue, PR comments, check runs, cloning
  worker/ queue consumer that runs the engine on pull requests
  dashboard/ runs list and run detail page (Vite + React)
examples/ sample projects, each as base/ and pr/ snapshots
scripts/  dev helpers (example-repo.mjs turns a sample into a git repo)
tests/    checks that span the whole repo
```

`packages/dashboard` is the web page (Vite + React), served by the API.

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

## Using the CLI

```bash
npx writecode-proof doctor
```

Checks Node, git, your settings, Docker, the three sandbox images and the LLM, and says what to fix.

```bash
npx writecode-proof check path/to/repo
```

Compares the working tree (including uncommitted and new files) with `main` and prints the Proof Pack.

| Option              | Does                                                           |
| ------------------- | -------------------------------------------------------------- |
| `--base <ref>`      | Compare against another branch, tag or commit                  |
| `--head <ref>`      | Check a branch or commit instead of the working tree           |
| `--json`            | Machine-readable report on stdout (progress stays on stderr)   |
| `--out <file.md>`   | Also write the report as Markdown, in the PR comment format    |
| `--no-generate`     | Skip generated tests                                           |
| `--no-llm`          | Use no model at all: edge-case inputs only, no generated tests |
| `--provider <name>` | `ollama`, `openai-compatible` or `anthropic` for this run      |
| `--ai-authored`     | The change was written by an AI; adds to the score             |
| `-q, --quiet`       | No progress output                                             |

Exit codes: `0` Low or Medium, `1` High, `2` Blocked, `3` the tool itself failed.

### Risk score

0–10, from [weights.ts](packages/core/src/score/weights.ts):

| Signal                                                  | Points                                    |
| ------------------------------------------------------- | ----------------------------------------- |
| Existing test now failing                               | 3 each, up to 6                           |
| Behaviour change                                        | 3 per function, up to 6                   |
| Generated test failing (confirmed against the old code) | 1.5 each, up to 4.5                       |
| Security finding                                        | low 0.5, medium 1.5, high 3               |
| Diff size                                               | 0 at 50 changed lines, rising to 1 at 400 |
| Changed files no test imports                           | up to 1.5, by share                       |
| AI-authored                                             | 1                                         |

A leaked secret or critical finding blocks the change whatever the score. Under 3 is Low (auto-approve allowed), 3 to under 7 Medium (one reviewer), 7 and up High (code owner). Each report ends with the reason, e.g. `Why 6: 2 unexplained behaviour changes (+6)`.

### Repo settings

A repository can add `.writecode/proof.yml`:

```yaml
version: 1
mode: advise # advise | enforce
languages: [typescript, javascript, python]
tests:
  command: '' # e.g. "npm test"; empty = detect vitest, jest or pytest
  time_budget_seconds: 480
ignore: ['docs/**', '**/*.md']
generated_tests:
  max_functions: 10
policies:
  auto_approve_below: 3
  one_reviewer: [3, 6]
  code_owner_above: 7
  block_on: [critical_security, secret_leak]
  ai_authored_weight: 1.0
```

Every key is optional except `version`. Unknown keys and bad values are reported and the defaults are used. With `tests.command` set, the command runs on both versions and "passed before, fails now" is flagged.

## GitHub App

```
pull_request opened / synchronize / reopened
  → /webhook: verify signature → pending "WriteCode Proof" check → queue (Redis)
  → worker: shallow clone base + head → checks → score
  → one PR comment (updated in place on every push) + completed check → Postgres
```

- **One run per PR.** A new push replaces a run that is still waiting; a run already in progress notices it is stale and stops without posting. Both end as a neutral "Superseded by a newer push" check.
- **Config comes from the base branch**, so a pull request cannot loosen the rules it is checked against.
- **AI-authored** means a bot author or the `ai-generated` label (`GITHUB_AI_LABEL`).
- **Status check:** success for Low and Medium, neutral for High (failure with `mode: enforce`), failure for Blocked.
- **If a run fails**, the comment says what went wrong, the check is neutral, and the run is stored as an error.
- **The installation token** reaches git through environment variables: it is never on a command line or written to disk.

### Setting it up

1. On GitHub: Settings → Developer settings → GitHub Apps → New GitHub App.
   - Webhook URL: create a channel at https://smee.io and paste its URL.
   - Webhook secret: any long random string.
   - Repository permissions: Checks read & write, Contents read, Pull requests read & write, Metadata read.
   - Subscribe to events: Pull request.
2. After creating it, note the App ID and generate a private key. Save the key as `github-app.pem` in this folder (gitignored).
3. In `.env`: `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, `WEBHOOK_PROXY_URL` (the smee URL).
4. Install the app on a test repository.
5. Run:

```bash
npm run infra:up
```

```bash
npm run dev
```

Then open a pull request on the test repository. Without the app settings the API still starts; the webhook answers 503 and the log says which setting is missing.

### Dashboard

Open http://127.0.0.1:3100 once the API is running (`npm run dev`, or `node packages/api/dist/index.js`). It lists every run, newest first, from pull requests and from local checks, with the risk, status and the reason for the score. Each run has a page with its checks and findings, most serious first. Runs that are queued or running update by themselves.

Local checks show up there when `DATABASE_URL` is set; `writecode-proof check --no-store` skips saving. If the database is down the check still runs and only warns.

`npm run build` builds the dashboard and the API serves it on `PORT`. While working on the dashboard itself, `npm run dev:dashboard` serves it with live reload on `DASHBOARD_PORT` and forwards `/api` to the API.

### API

| Method | Path                                         | Returns                                                     |
| ------ | -------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/webhook`                                   | GitHub deliveries (signature checked against the raw body)  |
| GET    | `/api/runs?page=1&pageSize=20&source=github` | Runs, newest first                                          |
| GET    | `/api/runs/:id`                              | One run with its checks and findings                        |
| GET    | `/api/meta`                                  | Version and the GitHub web address for links                |
| GET    | `/health`                                    | Liveness, plus whether the database and queue are reachable |

The database stores runs, findings and short snippets; never source code. Tables are created on start-up from the SQL in `packages/db/migrations`.

## Checks

A run exports base and head into a fresh temp folder, installs dependencies once per lockfile, then runs four checks. The model works in the background while the sandbox runs the first two.

**Existing tests.** Finds vitest, jest or pytest tests that import a changed file (or the whole suite if none do), runs them on base and head, and flags any test that passed before and fails now.

**Security.** Semgrep runs on the changed files of both sides; only findings that are new on head are reported, matched by rule and code so a shifted line is not "new". Gitleaks scans only the added lines, with `--redact`, so a leaked secret is never copied into a report. Any secret is critical.

**Behaviour diff.** Each modified, exported function is called with the same inputs on base and head: up to 10 from the model (it sees both versions and picks inputs likely to split them) plus generic edge cases like `[]`, `0`, `1.999` and `null`. `Math.random`, `Date`, `random` and `time.time` are frozen; each side runs twice and anything that differs between identical runs is ignored. A call that hangs is stopped and reported. Results read like `cheapestItem([]) throws TypeError (was null)`. Same error type with a different message is not counted as a change.

**Generated tests.** For up to 10 changed functions, the model writes 4–6 tests (`node:test` for JS/TS, pytest for Python). Files that don't load are dropped. Tests then run on head and, for modified functions, on base:

- passes on base, fails on head → reported (medium): the change broke something the old code did right
- fails on both → dropped: the model guessed wrong
- new function, fails → shown as unconfirmed (info), not scored

Passing tests are run against up to 2 mutants of the function (a flipped comparison, a changed constant, an early return). A test that fails on none of them checks nothing and is counted as weak.

JS tests use Node's built-in runner rather than the repo's own, so they run the same way in every repo, with no config to load and nothing to install.

### Speed

On a laptop with a 4 GB GPU, `qwen2.5-coder:7b` writes about 7 tokens a second, so a first run on `js-sample` takes about 2.5–3 minutes. Model replies are cached by prompt, so runs on unchanged code take under a minute. Dependency installs are cached in Docker volumes per lockfile. `npm run cache:clear` removes both.

Install scripts are not run (`--ignore-scripts`): the install step is the only one with network access, and lifecycle scripts would be repository code running online.

## When things go wrong

A run never reports something it did not check.

- **A check cannot run** (Docker stops, the model is unreachable, the time budget runs out): the report says **Incomplete** instead of Low/Medium/High, names each check that did not run and why, e.g. `Security: Could not run: Lost connection to Docker while starting a sandbox. Is Docker Desktop running?`. Findings made before the failure still count. The GitHub check is neutral (never success), the CLI exits with code 3, and the dashboard shows the run as Incomplete.
- **The model stops answering**: the behaviour diff carries on with its own edge-case inputs; generated tests say `Could not run: Cannot reach Ollama at … Is Ollama running?`.
- **Rate limits**: model APIs (429, 503, 529) are retried once after the wait they ask for, at most 30 s. GitHub API calls wait out primary and secondary rate limits (up to 60 s, twice) and retry server errors.
- **Postgres is down**: pull requests are still checked and commented on; only the record is skipped (logged). The API answers 503 instead of an error page.
- **Redis is down**: the webhook answers 503 within 5 s so GitHub can redeliver later; the API and worker log the problem and reconnect by themselves.
- **The worker crashes mid-run**: the job is retried once; if it fails again, the pull request gets an error comment and a neutral check. Every 10 minutes (and at start-up) the worker removes containers, run folders and clones older than `RUN_BUDGET_S` + 10 minutes, and marks runs stuck as "running" as interrupted.
- **Errors** are logged in full on the server; clients only get a short message, never SQL or stack traces.
- **The API is rate-limited** per client (`RATE_LIMIT_PER_MINUTE`, default 120; `/health` is exempt). Set `TRUST_PROXY=true` behind nginx so the limit applies per real client.

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

## Verifying Phase 4

Docker Desktop and Ollama must be running, with the model pulled (`ollama pull qwen2.5-coder:7b`).

```bash
npm run build:images
```

```bash
npm run test:sandbox
```

[checks.docker.test.ts](tests/sandbox/checks.docker.test.ts) runs the whole pipeline on both samples with a scripted model, so results are exact: the empty-list crash and the rounding change are reported by the behaviour diff and confirmed by generated tests, existing tests pass, nothing is left behind. It also checks a broken existing test, new vs pre-existing Semgrep findings, and that a planted GitHub token is caught but never appears in the output. Add `WCP_TEST_LLM=1` to also run once with the real model.

To see a full run with your model:

```bash
npm run examples
```

```bash
npx writecode-proof check .examples/js-sample
```

## Verifying Phase 5

```bash
npx writecode-proof doctor
```

```bash
npm run examples
```

```bash
npx writecode-proof check .examples/js-sample
```

The samples live in `examples/<name>` as `base/` and `pr/` folders; `npm run examples` turns them into git repos under `.examples/`, which is what `check` needs. With Ollama and `qwen2.5-coder:7b` on a 4 GB laptop GPU a first run takes about 2.5 minutes and prints Risk 10/10 High (exit code 1), with the crash and the rounding change listed under Why.

[cli.docker.test.ts](tests/sandbox/cli.docker.test.ts) runs the built command against real repos: JSON and Markdown output, every exit code (Medium 0, High 1, Blocked 2, tool error 3), `--ai-authored`, the repo config and `doctor`.

## Verifying Phase 6

Postgres and Redis must be up (`npm run infra:up`).

```bash
npm run test:sandbox
```

[github.docker.test.ts](tests/sandbox/github.docker.test.ts) runs the whole GitHub flow against real Postgres and Redis, the real queue and worker, and a real git remote serving `refs/pull/1/head` the way GitHub does; only the GitHub API is a recorder. It checks: a pending check, then one comment with the score and a successful check; the run and its findings in Postgres and on `/api/runs`; a second push updating the same comment; a push that replaces a waiting run; and a failing clone producing an error comment, a neutral check and an error run. It uses its own database and Redis prefix and removes them afterwards.

The live test needs your GitHub App (see Setting it up): open a pull request on the test repo, check the comment and the "WriteCode Proof" check appear, push again and check the same comment changes.

## Verifying Phase 7

```bash
npm run build
```

```bash
npm run examples
```

```bash
npx writecode-proof check .examples/js-sample
```

```bash
node packages/api/dist/index.js
```

Open http://127.0.0.1:3100: the local check is listed; click it to see its checks and findings. Pull request runs appear the same way once the GitHub App is set up.

Automated: [dashboard.test.tsx](packages/dashboard/test/dashboard.test.tsx) renders both pages against a fake API (runs from both sources, filters, empty and error states, findings order, deep links). [cli.docker.test.ts](tests/sandbox/cli.docker.test.ts) checks that a CLI run is stored with its findings, and [github.docker.test.ts](tests/sandbox/github.docker.test.ts) that a pull request run is, both read back through `/api/runs`.

## Verifying Phase 8

```bash
npm run test:sandbox
```

[resilience.docker.test.ts](tests/sandbox/resilience.docker.test.ts) cuts Docker off in the middle of a real pull request run (the client is pointed at a socket that no longer exists, which is what it sees when Docker Desktop stops), points the model at a port where nothing listens part-way through, crashes a job outside the run, and leaves stale containers, folders and runs behind. It checks the pull request gets a clear Incomplete or error report, nothing crashes, the next run works, and the clean-up removes only what is old. To do it by hand, see "Breaking it on purpose" below.

## Testing it yourself

From an empty Windows machine to a checked pull request. About 30 minutes, most of it downloads.

### 1. Install

- Docker Desktop, with the WSL2 backend. Start it.
- Node.js 20.12 or newer, and Git.
- Ollama. Then:

```bash
ollama pull qwen2.5-coder:7b
```

### 2. Set up

```bash
npm install
```

```bash
cp .env.example .env
```

In `.env`, set `POSTGRES_PASSWORD` and put the same password in `DATABASE_URL`. Then:

```bash
npm run infra:up
```

```bash
npm run build:images
```

```bash
npm run build
```

```bash
npx writecode-proof doctor
```

Every line should be green. If not, the line says what to do.

### 3. Check a change from the command line

```bash
npm run examples
```

```bash
npx writecode-proof check .examples/js-sample
```

Expect Risk 10/10 High (exit code 1) within about 3 minutes on the first run, with `cheapestItem([]) throws TypeError (was null)` and a rounding change under Findings. A second run takes under a minute. Try the Python sample too, and `--no-llm` for a run without the model (6/10 Medium).

To check your own project, run `check` in its folder; it compares your uncommitted work with `main` (`--base` for another branch).

### 4. Look at the dashboard

```bash
node packages/api/dist/index.js
```

Open http://127.0.0.1:3100. The runs from step 3 are listed; click one for its checks and findings.

### 5. Try it on a pull request

Follow [Setting it up](#setting-it-up) under GitHub App, then `npm run dev` and open a pull request on your test repository. Within a few minutes the "WriteCode Proof" check and a comment appear. Push again: the same comment updates.

### 6. Breaking it on purpose

| Do this during a run                                   | You should see                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quit Ollama                                            | Generated tests: "Could not run: Cannot reach Ollama…". Risk shows Incomplete; CLI exit code 3; PR check neutral.                                                                                                                   |
| Quit Docker Desktop                                    | The checks still to run: "Could not run: Lost connection to Docker…". Incomplete as above. If Docker is gone before the run starts: "Cannot reach Docker. Is Docker Desktop running?" (exit code 3, or an error comment on the PR). |
| `docker compose stop redis` with `npm run dev` running | Webhook deliveries fail with 503 (GitHub shows them as failed and can redeliver); nothing crashes. `docker compose start redis` and it carries on.                                                                                  |
| `docker compose stop postgres`                         | The dashboard shows "Could not load runs"; pull requests are still checked and commented on.                                                                                                                                        |
| Stop the worker (Ctrl+C twice) mid-run, start it again | The run is retried, or reported as "Could not finish" on the PR.                                                                                                                                                                    |

### 7. Run the tests

```bash
npm test
```

```bash
npm run test:sandbox
```

The first takes under a minute and needs nothing running. The second needs Docker, the images, Postgres and Redis, and takes about 15 minutes.

### Troubleshooting

| Message                                                | Fix                                                                                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `Cannot reach Docker. Is Docker Desktop running?`      | Start Docker Desktop and wait until it says it is running.                                                                    |
| `Sandbox image … not found. Run: npm run build:images` | Run it; needed once, and after the Dockerfiles change.                                                                        |
| `Ollama has no model "…"`                              | `ollama pull` the model named, or change `LLM_MODEL`.                                                                         |
| `… is not inside a git repository`                     | Point `check` at a folder inside a git repo. For the samples, run `npm run examples` and use `.examples/<name>`.              |
| `Cannot find "main"`                                   | The repo's main branch has another name: pass `--base master` (or whatever it is).                                            |
| `Cannot reach Postgres at localhost:5433`              | Postgres is stopped: run `npm run infra:up`, then start again.                                                                |
| `set POSTGRES_PASSWORD in .env` when starting infra    | Copy `.env.example` to `.env` and set the password (step 2).                                                                  |
| Port 5433, 6380 or 3100 already in use                 | Change `POSTGRES_PORT`, `REDIS_PORT` or `PORT` in `.env` (and `DATABASE_URL`/`REDIS_URL` to match).                           |
| First run is slow                                      | The model writes about 7 tokens a second on a small GPU. Later runs reuse its answers; `--no-generate` or `--no-llm` skip it. |
| Want a clean slate                                     | `npm run cache:clear` removes cached dependencies and model answers.                                                          |
