# WriteCode Proof — Build Spec (MVP)

Proof-carrying pull requests for WriteCode. This is the complete brief for building the standalone MVP with Claude Code.

- **Owner:** Ashok (WriteCode, writecode.in)
- **Status:** Not started. Build as a standalone project first. Integrate with WriteCode.in only after it works locally and Ashok approves.
- **Date:** October 2026

---

## 0. Hard rules (read first)

1. **Work only inside this folder: `Projects/writecode-proof/`.**
2. **Do not read, edit, move or delete anything in the WriteCode / code-workspace folder** or in any other folder (`Arc-Estates`, `portfolio`, …). Not even to "look for reuse".
3. No integration with WriteCode.in until Ashok says the local version works. When that time comes, list the exact files to change and wait for approval.
4. Never commit secrets. Use `.env` (gitignored) + `.env.example`.
5. The development machine is **Windows**. Use Docker Desktop (WSL2 backend), cross-platform Node scripts, and no bash-only tooling in npm scripts.

---

## 1. What we are building

Every pull request (PR), especially AI-written ones, gets an automatic **Proof Pack**:

| Check | What it does |
| --- | --- |
| Existing tests | Runs the repo's tests that relate to the changed code, on old and new versions |
| Generated tests | LLM writes tests for each changed function; keep only tests that pass on new code |
| Behaviour diff | Runs the same inputs through old (base) and new (PR) code and compares outputs |
| Security scan | Semgrep (community rules) + Gitleaks (secrets) |
| Risk score | 0–10, weighted, explainable in one sentence |

Output: **one PR comment** + **one GitHub status check**. Merge rules use the score.

Three ways to run the same engine:

1. **CLI (`writecode-proof`)** — local, on the developer's machine. Build this FIRST.
2. **GitHub App** — automatic on every PR.
3. **Dashboard** — small web page listing runs and results.

---

## 2. MVP scope

**In**
- Languages: JavaScript/TypeScript and Python
- CLI: compare working tree (or a branch) against `main`
- GitHub App: PR opened/synchronize → Proof Pack comment + status check
- Generated tests, behaviour diff (function level), security scan, risk score
- Docker sandbox with strict limits
- LLM via provider adapter: **Ollama (local, default)** or an OpenAI-compatible / Anthropic API key
- Postgres for runs; Redis queue
- Minimal dashboard (list of runs, one run detail page)

**Out (later)**
- GitLab/Bitbucket, license check, call graph / blast radius, intent match
- Custom YAML policies beyond three presets, SSO, audit export
- API-level behaviour diff, other languages
- WriteCode.in integration (phase after local sign-off)

---

## 3. Tech stack

| Part | Choice |
| --- | --- |
| Language | TypeScript (Node.js 20+) for api, worker, cli, shared engine |
| Monorepo | npm workspaces (`packages/*`) |
| API server | Fastify |
| GitHub | `@octokit/app`, `@octokit/webhooks` |
| Queue | BullMQ + Redis 7 |
| Database | Postgres 16 + Prisma (or Drizzle) |
| Sandbox | Docker via `dockerode`; per-language images |
| Code parsing | `tree-sitter` (+ javascript, typescript, python grammars) |
| Diff parsing | `parse-diff` / `git diff --unified=0` |
| Security | Semgrep CLI, Gitleaks (run inside the sandbox/tool image) |
| Tests | Vitest for our own code; Jest/Vitest/pytest for target repos |
| CLI | `commander` + `picocolors` |
| Dashboard | Vite + React (simple), served by the API in production |
| Local webhook tunnel | smee.io (`smee-client`) |

---

## 4. Folder structure

```
writecode-proof/
├── CLAUDE.md                     # rules for Claude Code (folder boundary)
├── WRITECODE_PROOF_SPEC.md       # this file
├── README.md                     # setup + how to test
├── package.json                  # npm workspaces
├── docker-compose.yml            # postgres, redis, api, worker
├── .env.example
├── packages/
│   ├── core/                     # the engine, shared by CLI and worker
│   │   └── src/
│   │       ├── diff/             # parse git diff → changed files/functions
│   │       ├── parse/            # tree-sitter: find functions, signatures
│   │       ├── sandbox/          # docker runner with limits
│   │       ├── checks/
│   │       │   ├── existingTests.ts
│   │       │   ├── generatedTests.ts
│   │       │   ├── behaviourDiff.ts
│   │       │   └── security.ts
│   │       ├── llm/              # provider adapters: ollama, openai-compatible, anthropic
│   │       ├── score/            # risk scoring
│   │       ├── report/           # markdown comment + terminal output
│   │       └── types.ts
│   ├── cli/                      # `writecode-proof` command
│   ├── api/                      # Fastify: /webhook, /api/runs, /health
│   ├── worker/                   # BullMQ consumer → core engine → GitHub
│   └── dashboard/                # Vite + React
├── sandbox-images/
│   ├── node/Dockerfile
│   ├── python/Dockerfile
│   └── tools/Dockerfile          # semgrep + gitleaks
├── examples/
│   ├── js-sample/                # tiny repo with a known bug for demos
│   └── py-sample/
└── tests/                        # tests for the engine itself
```

---

## 5. How a run works (pipeline)

```
input (CLI: local repo | GitHub: PR event)
  → 1. resolve base + head commits
  → 2. create two checkouts (base/, head/) in a temp workdir
  → 3. diff → changed files → changed functions (tree-sitter)
  → 4. build sandbox (install deps, cached by lockfile hash)
  → 5. run checks in parallel:
        existing tests | generated tests | behaviour diff | security
  → 6. risk score
  → 7. report: terminal (CLI) or PR comment + status check (GitHub)
  → 8. store run in Postgres; delete workdir + containers
```

### Step details

**1–2. Checkouts**
- CLI: base = `main` (flag `--base`), head = working tree (including uncommitted changes) or `--head <branch>`.
- GitHub: clone with an installation token (shallow, `--depth=50`), checkout `base.sha` and `head.sha` into separate dirs.
- Use `git worktree` locally where possible; copy for uncommitted changes.

**3. Changed functions**
- Parse `git diff --unified=0 base head`.
- For each changed file in a supported language, parse both versions with tree-sitter and map changed line ranges to enclosing functions/methods.
- Record per function: name, file, signature, params, old body, new body, status (`added | modified | deleted`).
- Skip files matching ignore globs (docs, markdown, lockfiles, generated, tests themselves).

**4. Sandbox build**
- Detect project type: `package.json` → node; `pyproject.toml`/`requirements.txt` → python.
- Install deps once per lockfile hash; cache in a named Docker volume.

**5a. Existing tests**
- Detect runner: `vitest`/`jest` in package.json, or `pytest`.
- MVP selection: run test files that import a changed file (simple import scan), else the whole suite with a time cap.
- Run on base and head. Flag tests that pass on base and fail on head.

**5b. Generated tests**
- For each changed/added function (cap: 10 per run), prompt the LLM with: function source, signature/types, file imports, 1–2 call sites if easy to find.
- Ask for a test file in the repo's runner style covering: normal case, empty/null inputs, boundaries, error paths.
- Run each generated test against **head**. Discard tests that fail to compile/import.
- **Quality filter (mutation-lite):** apply 1–2 simple mutations to the function (flip a comparison, change a constant, return early) and keep only tests that fail on at least one mutant. Mark filtered tests as `weak`.
- Tests that fail on head → findings ("possible bug on edge case X").

**5c. Behaviour diff (function level)**
- For each **modified** function that is exportable/pure enough:
  - Ask the LLM for 10–20 representative inputs as JSON (or generate simple ones from param types).
  - Build a small harness that imports the function from `base/` and from `head/`, calls both with each input, captures `{ return value | thrown error type+message }`.
  - Freeze nondeterminism: fixed `Math.random` seed / `random.seed`, frozen `Date.now`.
  - Run each side twice; ignore fields that differ between identical runs.
  - Report each input where results differ.
- Functions that can't be isolated (DB, network, side effects) → mark `skipped` with reason. Never fail the run because of this.

**5d. Security**
- Run Semgrep (`--config auto` or `p/default`, community rules) on changed files only.
- Run Gitleaks on the diff only.
- Map severities: `ERROR`→high, `WARNING`→medium, `INFO`→low. Any leaked secret → critical.

**6–7. Score + report** (sections 7 and 8)

**8. Cleanup** — always remove containers and temp dirs, even on failure (`try/finally`).

---

## 6. Sandbox security (non-negotiable)

Every container that runs target-repo code:

```
--network none            (deps installed in a separate, earlier step with network)
--cpus 1
--memory 2g --memory-swap 2g
--pids-limit 256
--read-only  + tmpfs /tmp
--user 1000:1000          (non-root)
--cap-drop ALL
--security-opt no-new-privileges
hard timeout per step (default 120s), whole run budget (default 8 min)
```

- Mount only the run's temp workdir. **Never** mount the host home, other projects, or the Docker socket into sandboxes.
- The worker may talk to Docker; sandboxes may not.
- Delete containers and workdirs after every run.
- Optional later: gVisor (`runsc`) runtime on Linux servers.

---

## 7. Risk score

`risk = min(10, round(Σ weight × signal, 1))`

| Signal | Weight |
| --- | --- |
| Existing test now failing (pass on base, fail on head) | 3.0 each, max 6 |
| Unexplained behaviour change | 3.0 each, max 6 |
| Generated test failing on head | 1.5 each, max 4.5 |
| Security finding | low 0.5, medium 1.5, high 3, critical → blocked |
| Diff size | 0–1 (0 under 50 changed lines, 1 above 400) |
| Low test coverage of changed functions (no tests found) | 0–1.5 |
| AI-authored PR (bot author or label `ai-generated`) | 1.0 (configurable) |

Bands:

| Score | Label | Default action |
| --- | --- | --- |
| 0–2 | Low | Auto-approve allowed |
| 3–6 | Medium | One human reviewer |
| 7–10 | High | Code owner review |
| critical | Blocked | Status check fails |

Always produce a one-line **"Why"** listing the top contributors, e.g.
`Why 6: 1 unexplained behaviour change (+3), 1 failing generated test (+1.5), AI-authored (+1), 2 services touched (+0.5)`.

Weights live in one file (`packages/core/src/score/weights.ts`) and can be overridden from config.

---

## 8. Report formats

### PR comment (Markdown)

```
## WriteCode Proof · Risk 6/10 · Medium — one reviewer required

Changed 6 functions in 4 files.

| Check | Result |
|---|---|
| Existing tests | ✅ 118 run, 118 pass |
| Generated tests | ⚠️ 21 written, 20 pass — `applyDiscount([])` throws TypeError |
| Behaviour diff | ⚠️ 1 change: 100% coupon → total -0.01 (was 0.00) |
| Security | ✅ No findings |

**Why 6:** …

<details><summary>Details</summary> … per-function results, inputs, outputs … </details>

<sub>Run abc123 · 3m 12s · WriteCode Proof</sub>
```

- Update the same comment on new pushes (find by a hidden marker `<!-- writecode-proof -->`), don't spam new ones.

### Status check
- Name: `WriteCode Proof`
- `success` for Low/Medium (with summary), `neutral` in advise mode, `failure` for Blocked (and for High when `mode: enforce`).

### CLI output
Same content, coloured, plus `--json` flag for machine output and `--out report.md`.

---

## 9. Config file (target repo)

`.writecode/proof.yml` (optional; defaults apply):

```yaml
version: 1
mode: advise            # advise | enforce
languages: [typescript, javascript, python]
tests:
  command: ""           # auto-detect if empty
  time_budget_seconds: 480
ignore: ["docs/**", "**/*.md"]
generated_tests:
  max_functions: 10
policies:
  auto_approve_below: 2
  one_reviewer: [3, 6]
  code_owner_above: 7
  block_on: [critical_security, secret_leak]
  ai_authored_weight: 1.0
```

Validate with `zod`; on invalid config, comment the error and fall back to defaults.

---

## 10. LLM adapter

Interface:

```ts
interface LlmProvider {
  name: string;
  complete(opts: { system: string; prompt: string; maxTokens?: number; json?: boolean }): Promise<string>;
}
```

Providers: `ollama` (default, `OLLAMA_URL=http://localhost:11434`, model from env), `openai-compatible` (base URL + key), `anthropic` (key). Selected by `LLM_PROVIDER`.

Rules: keep prompts in `packages/core/src/llm/prompts/`; ask for JSON where possible and validate with zod; retry once on bad output; cache responses by hash of (function source + prompt version).

---

## 11. Database (Postgres)

```
installations(id, github_installation_id, account_login, created_at)
repos(id, installation_id, full_name, config_json, created_at)
runs(id, repo_id NULL, source ['cli'|'github'], pr_number NULL, base_sha, head_sha,
     status ['queued'|'running'|'done'|'error'|'cancelled'],
     risk_score NULL, risk_band NULL, why TEXT, duration_ms, created_at, finished_at)
findings(id, run_id, check ['existing_tests'|'generated_tests'|'behaviour_diff'|'security'],
         severity, title, detail_json, file, line, created_at)
```

Do not store source code; store only findings and short snippets around them.

---

## 12. API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/webhook` | GitHub webhooks (verify signature) |
| GET | `/api/runs` | List runs (paginated) |
| GET | `/api/runs/:id` | Run detail + findings |
| GET | `/health` | Liveness |

Webhook handling: on `pull_request` `opened | synchronize | reopened` → set pending status → enqueue job (job id = `repo#pr`, so a new push replaces/cancels the old one).

---

## 13. Environment variables (`.env.example`)

```
# GitHub App
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY_PATH=./github-app.pem
GITHUB_WEBHOOK_SECRET=
WEBHOOK_PROXY_URL=          # smee.io channel for local testing

# Infra
DATABASE_URL=postgresql://proof:proof@localhost:5433/proof
REDIS_URL=redis://localhost:6380
PORT=3100

# LLM
LLM_PROVIDER=ollama         # ollama | openai-compatible | anthropic
OLLAMA_URL=http://localhost:11434
LLM_MODEL=qwen2.5-coder:7b
LLM_BASE_URL=
LLM_API_KEY=

# Sandbox
SANDBOX_CPUS=1
SANDBOX_MEMORY=2g
SANDBOX_STEP_TIMEOUT_S=120
RUN_BUDGET_S=480
MAX_CONCURRENT_RUNS=1
```

Ports are deliberately **non-default** (5433, 6380, 3100) so they don't clash with anything else already running (local or on the VPS).

---

## 14. CLI

```
npx writecode-proof check [path]            # default: working tree vs main
  --base <ref>        default main
  --head <ref>        default working tree
  --json              machine output
  --out <file.md>     write the report
  --no-generate       skip generated tests (faster)
  --provider ollama|openai-compatible|anthropic

npx writecode-proof doctor                  # checks Docker, git, LLM reachability
```

Exit codes: 0 = Low/Medium, 1 = High, 2 = Blocked, 3 = tool error.

---

## 15. Build plan for Claude Code (phases with acceptance criteria)

Do one phase at a time. Stop after each phase, show what was built and how to test it.

### Phase 1 — Skeleton
- npm workspaces, TypeScript config, lint, Vitest, `docker-compose.yml` (postgres:5433, redis:6380), `.env.example`, README.
- **Done when:** `npm install && npm test` passes; `docker compose up -d` starts db + redis.

### Phase 2 — Diff + function detection (core)
- Parse git diff; tree-sitter for JS/TS/Python; list changed functions.
- **Done when:** unit tests on `examples/js-sample` and `examples/py-sample` correctly list changed functions.

### Phase 3 — Sandbox runner
- Build `sandbox-images/node`, `python`, `tools`. `dockerode` runner with all limits from section 6, timeouts, cleanup.
- **Done when:** a test proves the sandbox has no network, cannot write outside `/work` and `/tmp`, and is killed on timeout.

### Phase 4 — Checks
- existing tests → security → behaviour diff → generated tests (in that order; generated tests last because they need the LLM).
- **Done when:** on `examples/js-sample` (with a planted bug: empty-array crash + changed rounding), the run reports the failing edge case and the behaviour change.

### Phase 5 — Score + CLI
- Risk score, "Why" line, terminal report, `--json`, `--out`, `doctor`.
- **Done when:** `npx writecode-proof check examples/js-sample` prints a Proof Pack with score and reasons in under 3 minutes with Ollama.

### Phase 6 — GitHub App
- Fastify `/webhook`, BullMQ queue, worker, PR comment (update-in-place), status check, Postgres storage. smee.io for local delivery.
- **Done when:** opening a PR on a personal test repo produces the comment + check; pushing again updates the same comment.

### Phase 7 — Dashboard
- Runs list + run detail page reading `/api/runs`.
- **Done when:** runs from CLI and GitHub both appear with findings.

### Phase 8 — Hardening
- Error handling, partial results when budget is hit, logs, rate limits, README "Testing it yourself" section.
- **Done when:** killing Docker or Ollama mid-run produces a clear error comment, not a crash.

### Later — after Ashok's sign-off only
- WriteCode.in integration ("Verify" button in the editor, "Open in WriteCode" side-by-side replay).
- Deploy to the Hostinger VPS (see section 17).

---

## 16. Testing it locally on Windows

1. Install **Docker Desktop** (WSL2 backend), **Node 20+**, **Git**, **Ollama** (`ollama pull qwen2.5-coder:7b`).
2. `cd Projects/writecode-proof && npm install`
3. `cp .env.example .env` and fill values.
4. `docker compose up -d` (db + redis)
5. Build sandbox images: `npm run build:images`
6. CLI test: `npx writecode-proof check examples/js-sample`
7. GitHub test:
   - Create a GitHub App (Settings → Developer settings → GitHub Apps). Permissions: Contents read, Pull requests write, Checks write, Metadata read. Events: Pull request.
   - Create a smee.io channel, set it as the webhook URL and `WEBHOOK_PROXY_URL`.
   - `npm run dev` (api + worker + smee client).
   - Install the app on a **test repo**, open a PR with a planted bug, check the comment.

---

## 17. Later: Hostinger VPS deployment notes (do not do yet)

VPS: Hostinger **KVM 2** (Ubuntu), already running another app. Rules:

- Take a Hostinger snapshot before any change.
- Install into `/opt/writecode-proof` with its own compose project and network.
- Reuse the existing Nginx: add only a server block for `proof.writecode.in` → `127.0.0.1:3100`; `nginx -t` before reload; Certbot for HTTPS.
- Bind postgres/redis to `127.0.0.1` on 5433/6380 only (Docker bypasses UFW otherwise).
- `MAX_CONCURRENT_RUNS=1`, `SANDBOX_CPUS=1`, `SANDBOX_MEMORY=2g` so the existing app keeps its CPU and RAM.
- Daily cron: `docker system prune -f --filter "until=24h"`.
- Use an LLM API from the VPS (no local model on a CPU-only VPS).
- Move workers to a second VPS when pilots start using it daily.

---

## 18. Definition of done for the MVP

- CLI produces a correct Proof Pack on both sample repos.
- GitHub App comments + sets status on a real PR, and updates on new pushes.
- Sandbox limits proven by tests.
- No source code stored; workdirs cleaned up.
- README lets someone else set it up from scratch on Windows.

---

## 19. First prompt to paste into Claude Code

> Read `CLAUDE.md` and `WRITECODE_PROOF_SPEC.md` in this folder. Work only inside this folder. Start with Phase 1 from section 15. When Phase 1 is done, stop, summarise what you built, and tell me how to verify it before moving to Phase 2.
