# WriteCode Proof

Every pull request gets a Proof Pack: the repo's own tests run on old and new code, generated tests for each changed function, a behaviour diff, a Semgrep + Gitleaks scan, and a 0–10 risk score with the reason behind it.

The full spec is in [WRITECODE_PROOF_SPEC.md](WRITECODE_PROOF_SPEC.md).

## Status

| Phase | What                                     | State   |
| ----- | ---------------------------------------- | ------- |
| 1     | Skeleton: workspaces, config, infra      | Done    |
| 2     | Diff + changed-function detection        | Next    |
| 3     | Docker sandbox runner                    | Pending |
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

| Command              | Does                                  |
| -------------------- | ------------------------------------- |
| `npm test`           | Run all tests (no build needed)       |
| `npm run build`      | Compile every package to `dist/`      |
| `npm run lint`       | ESLint                                |
| `npm run format`     | Prettier                              |
| `npm run infra:up`   | Start Postgres + Redis                |
| `npm run infra:down` | Stop them (data stays in the volumes) |
| `npm run infra:logs` | Follow their logs                     |

## Layout

```
packages/
  core/   engine shared by the CLI and the worker (config lives here)
  cli/    the `writecode-proof` command
  api/    Fastify server: /health now; /webhook and /api/runs later
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

## Verifying Phase 1

```bash
npm install
npm test
npm run build
node packages/cli/dist/index.js --version
npm run infra:up
docker compose ps
```

You should see 23 passing tests, the CLI printing `0.1.0`, and both containers showing `healthy`.

To check the API:

```bash
node packages/api/dist/index.js
```

Then open http://127.0.0.1:3100/health in a browser.
