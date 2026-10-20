# Private repo delivery checklist

Use when a user asks to publish a newly built local artifact into one or more private GitHub repositories.

## Flow

1. Verify GitHub auth with `gh api user`.
2. Check target repo names with `gh repo view OWNER/REPO` or a repo verification tool.
3. If splitting an artifact into multiple repos, create clean sibling directories and copy only durable files:
   - source code and tests
   - lockfiles and package manifests
   - Docker/compose/wrangler/deploy config
   - README and examples
   - `.gitignore` / `.dockerignore`
4. Exclude runtime and generated artifacts:
   - `.env`, `.dev.vars`, credentials
   - `.venv`, `node_modules`, `__pycache__`, `.pytest_cache`
   - runtime data directories and smoke-test containers/files
5. Run each split repo's own checks from its own directory.
6. Initialize git, inspect staged files, commit, and create the repo with `--private --source . --remote origin --push`.
7. Verify after push:
   - `isPrivate=true`
   - default branch is expected
   - remote URL is set
   - remote `main` commit equals local HEAD
   - local worktree is clean

## Pitfalls

- Do not rely on tests from the pre-split workspace; dependency paths and ignored files can change after splitting.
- Re-read README examples after writing. Secret redaction can distort token-looking placeholders in tool output or files; use non-secret sample placeholders and verify the final markdown.
- If deploy config contains placeholder URLs, add a deploy-time validation guard so the repo cannot be deployed as-is to a reserved/example hostname.
- When a review finds blockers after the first push, fix, re-run checks, commit, push again, and verify the remote SHA before reporting success.
