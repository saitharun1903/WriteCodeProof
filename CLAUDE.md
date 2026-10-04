# CLAUDE.md — WriteCode Proof

## Folder boundary (most important)
- Work ONLY inside this folder (`Projects/writecode-proof/`).
- Do NOT read, edit, move or delete anything in the WriteCode / code-workspace folder or any other project folder. Not even to look for code to reuse.
- Integration with WriteCode.in happens only after Ashok confirms the local version works. Then: list the exact files to change and wait for approval.

## What this project is
Standalone MVP of WriteCode Proof: proof-carrying pull requests (generated tests, behaviour diff, security scan, risk score). Full spec: `WRITECODE_PROOF_SPEC.md`.

## How to work
- Follow the phases in section 15 of the spec, one at a time. Stop after each phase, summarise, and explain how to verify it.
- Dev machine is Windows: Docker Desktop (WSL2), cross-platform npm scripts, no bash-only commands in package.json.
- TypeScript, npm workspaces, Vitest. Keep the engine in `packages/core` so CLI and worker share it.
- Sandbox containers must always use the limits in section 6 of the spec. Never mount the host home or the Docker socket into a sandbox.
- Never commit secrets; keep `.env.example` up to date.
- Use non-default ports: Postgres 5433, Redis 6380, API 3100.
