---
name: github-pr-workflow
description: "Class-level GitHub operations: authentication, repository management, issues, code review, PR lifecycle, CI monitoring/fixes, releases, and API/gh/git fallbacks."
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [GitHub, Pull-Requests, CI/CD, Git, Automation, Merge]
    related_skills: [github-auth, github-code-review]
---

# GitHub Pull Request Workflow

Complete guide for managing the PR lifecycle. Each section shows the `gh` way first, then the `git` + `curl` fallback for machines without `gh`.

## Prerequisites

- Authenticated with GitHub (see `github-auth` skill)
- Inside a git repository with a GitHub remote

### Quick Auth Detection

```bash
# Determine which method to use throughout this workflow.
# Prefer a real API probe over only `gh auth status`, because stale stored
# tokens can otherwise surface later as push/PR failures.
if command -v gh &>/dev/null && gh api user >/dev/null 2>&1; then
  AUTH="gh"
else
  AUTH="git"
  # Ensure we have a token for API calls
  if [ -z "$GITHUB_TOKEN" ]; then
    if [ -f ~/.hermes/.env ] && grep -q "^GITHUB_TOKEN=" ~/.hermes/.env; then
      GITHUB_TOKEN=$(grep "^GITHUB_TOKEN=" ~/.hermes/.env | head -1 | cut -d= -f2 | tr -d '\n\r')
    elif grep -q "github.com" ~/.git-credentials 2>/dev/null; then
      GITHUB_TOKEN=$(grep "github.com" ~/.git-credentials 2>/dev/null | head -1 | sed 's|https://[^:]*:\([^@]*\)@.*|\1|')
    fi
  fi
  if [ -n "$GITHUB_TOKEN" ]; then
    curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user >/dev/null \
      || echo "Warning: GITHUB_TOKEN is not accepted by GitHub"
  fi
fi
echo "Using: $AUTH"
```

If the code is complete but GitHub credentials are invalid, do not lose the work: commit locally, save a patch with `git format-patch origin/main..HEAD --stdout > output_to_user/<topic>.patch`, and report the exact re-auth/push commands.

### Extracting Owner/Repo from the Git Remote

Many `curl` commands need `owner/repo`. Extract it from the git remote:

```bash
# Works for both HTTPS and SSH remote URLs
REMOTE_URL=$(git remote get-url origin)
OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's|.*github\.com[:/]||; s|\.git$||')
OWNER=$(echo "$OWNER_REPO" | cut -d/ -f1)
REPO=$(echo "$OWNER_REPO" | cut -d/ -f2)
echo "Owner: $OWNER, Repo: $REPO"
```

---

## Direct-to-main maintenance requests

If the user explicitly asks to change `main` (for example, “убери из main” or “push directly to main”), do not default to a feature branch or PR. Use a clean canonical checkout, fail fast on dirty worktrees, update from `origin/main`, make the minimal maintenance commit, and push with an explicit refspec:

```bash
git fetch origin main --prune
git checkout -B main origin/main
# make the requested minimal change
git diff --check
git commit -m "chore: ..."
git push origin HEAD:main
```

For multi-repo requests, check every requested repo even when one is a no-op; report `Everything up-to-date` / no candidate files as a valid result for unchanged repos.

## 1. Branch Creation

This part is pure `git` — identical either way:

```bash
# Make sure you're up to date
git fetch origin
git checkout main && git pull origin main

# Create and switch to a new branch
git checkout -b feat/add-user-authentication
```

Branch naming conventions:
- `feat/description` — new features
- `fix/description` — bug fixes
- `refactor/description` — code restructuring
- `docs/description` — documentation
- `ci/description` — CI/CD changes

## 2. Making Commits

Use the agent's file tools (`write_file`, `patch`) to make changes, then commit:

```bash
# Stage specific files
git add src/auth.py src/models/user.py tests/test_auth.py

# Commit with a conventional commit message
git commit -m "feat: add JWT-based user authentication

- Add login/register endpoints
- Add User model with password hashing
- Add auth middleware for protected routes
- Add unit tests for auth flow"
```

Commit message format (Conventional Commits):
```
type(scope): short description

Longer explanation if needed. Wrap at 72 characters.
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `ci`, `chore`, `perf`

## 3. Pushing and Creating a PR

### Push the Branch (same either way)

```bash
git push -u origin HEAD
```

When several webhook/review workers may update the same PR head concurrently, fetch the exact target branch immediately before pushing. If remote moved, rebase the isolated worktree onto the new head, rerun the affected checks, and use a normal (non-force) explicit-refspec push. A non-fast-forward failure means fetch/rebase/retest again; never overwrite sibling fixes. After success, verify the commit is an ancestor of the remote ref and match CI by exact `head_sha`.

If the local branch name intentionally differs from its upstream branch (for example local `merge-prod-main` tracking `origin/main`), plain `git push` can fail under Git's `push.default=simple` with "upstream branch ... does not match the name of your current branch". After confirming the target, push with an explicit refspec instead of creating an unintended remote branch:

```bash
git push origin HEAD:main
# or replace main with the intended remote branch
```

**Post-push verification pitfall:** immediately after a successful push, `GET /repos/{owner}/{repo}/pulls/{number}` may briefly return the previous `.head.sha`. Do not repeat the push or report failure from that cached PR object alone. Verify the branch ref through `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` or `git ls-remote origin refs/heads/{branch}`, and verify the commit endpoint; re-read the PR object later only if its metadata itself matters.

### Fallback: HTTPS push 403 despite apparent GitHub access

If `gh repo view OWNER/REPO --json viewerPermission` or REST `permissions.push=true` suggests access, but `git push` to an HTTPS remote still returns `403`, do not keep retrying or embed tokens in logs. First test whether the user's SSH key has GitHub access, then switch the remote to SSH and push the same branch:

```bash
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new git@github.com
# success looks like: "Hi <user>! You've successfully authenticated..."

git remote set-url origin "git@github.com:$OWNER/$REPO.git"
git push -u origin HEAD
```

This often succeeds when `gh` API permissions are valid but the cached HTTPS credential used by git is stale or under-scoped.

### Fallback: fork push when upstream push or PR creation is blocked

If direct upstream push still fails, push the prepared branch to an authenticated fork and create/open a cross-repo PR:

```bash
USER=$(gh api user --jq .login)
FORK="$USER/$REPO"

gh repo fork "$OWNER/$REPO" --clone=false || true

if git remote get-url fork >/dev/null 2>&1; then
  git remote set-url fork "https://github.com/$FORK.git"
else
  git remote add fork "https://github.com/$FORK.git"
fi

git push -u fork HEAD

gh pr create \
  --repo "$OWNER/$REPO" \
  --head "$USER:$(git branch --show-current)" \
  --base main \
  --title "..." \
  --body-file /tmp/pr-body.md
```

If `gh pr create` fails with `GraphQL: Resource not accessible by personal access token (createPullRequest)`, the fine-grained PAT likely lacks **Pull requests: Read and write** for the upstream repo even if it can read/admin other metadata. Verify the diff and give the user the compare URL:

```bash
BRANCH=$(git branch --show-current)
gh api "repos/$OWNER/$REPO/compare/main...$USER:$BRANCH" \
  --jq '.status + " ahead_by=" + (.ahead_by|tostring) + " behind_by=" + (.behind_by|tostring) + " files=" + (.files|length|tostring)'
echo "https://github.com/$OWNER/$REPO/compare/main...$USER:$BRANCH?expand=1"
```

### Create the PR

**With gh:**

```bash
gh pr create \
  --title "feat: add JWT-based user authentication" \
  --body "## Summary
- Adds login and register API endpoints
- JWT token generation and validation

## Test Plan
- [ ] Unit tests pass

Closes #42"
```

Options: `--draft`, `--reviewer user1,user2`, `--label "enhancement"`, `--base develop`

**With git + curl:**

```bash
BRANCH=$(git branch --show-current)

curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/$OWNER/$REPO/pulls \
  -d "{
    \"title\": \"feat: add JWT-based user authentication\",
    \"body\": \"## Summary\nAdds login and register API endpoints.\n\nCloses #42\",
    \"head\": \"$BRANCH\",
    \"base\": \"main\"
  }"
```

The response JSON includes the PR `number` — save it for later commands.

To create as a draft, add `"draft": true` to the JSON body.

## 4. Monitoring CI Status

### Avoid duplicate checks on PR branch commits

When adding a new GitHub Actions workflow for “tests on every commit,” be deliberate about events:

- `on: push` for all branches is enough to test every pushed commit, including commits on open PR branches; GitHub displays that commit check in the PR.
- Combining broad `push` and broad `pull_request` triggers makes the same commit on an open PR branch run twice (`Tests and lint (push)` and `Tests and lint (pull_request)`). This is valid but noisy and wastes CI minutes.
- Use both only when you need PR-event-specific behavior (fork permission model, merge-commit testing, path filters that differ for PRs, required check names tied to `pull_request`, etc.). Otherwise prefer push-only plus deploy gating like `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`.

### Check CI Status

**With gh:**

```bash
# One-shot check
gh pr checks

# Watch until all checks finish (polls every 10s)
gh pr checks --watch
```

**Pitfall — `gh pr checks` can report a STALE `pending` after the run already finished.** `gh pr checks N` reads a cached check-rollup that lags the actual run state; it can keep printing `Tests and lint  pending` for many polls (observed 8+ consecutive 15s polls) after the job has genuinely passed. Do NOT conclude CI is stuck from `gh pr checks` alone. When it stays `pending` longer than the job's known runtime, confirm against the run itself, which shows the real status:

```bash
gh run list --branch "$(git branch --show-current)" --limit 3   # find the run id
gh run view <RUN_ID>                                             # e.g. "✓ Tests and lint in 40s"
```

Trust `gh run view <RUN_ID>` (or the REST `check-runs` endpoint in Section 4's git+curl block) over the `gh pr checks` rollup when the two disagree.

**With git + curl:**

```bash
# Get the latest commit SHA on the current branch
SHA=$(git rev-parse HEAD)

# Query the combined status
curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/commits/$SHA/status \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f\"Overall: {data['state']}\")
for s in data.get('statuses', []):
    print(f\"  {s['context']}: {s['state']} - {s.get('description', '')}\")"

# Also check GitHub Actions check runs (separate endpoint)
curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/commits/$SHA/check-runs \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for cr in data.get('check_runs', []):
    print(f\"  {cr['name']}: {cr['status']} / {cr['conclusion'] or 'pending'}\")"
```

### Poll Until Complete (git + curl)

```bash
# Simple polling loop — check every 30 seconds, up to 10 minutes
SHA=$(git rev-parse HEAD)
for i in $(seq 1 20); do
  STATUS=$(curl -s \
    -H "Authorization: token $GITHUB_TOKEN" \
    https://api.github.com/repos/$OWNER/$REPO/commits/$SHA/status \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])")
  echo "Check $i: $STATUS"
  if [ "$STATUS" = "success" ] || [ "$STATUS" = "failure" ] || [ "$STATUS" = "error" ]; then
    break
  fi
  sleep 30
done
```

## 5. Auto-Fixing CI Failures

When CI fails, diagnose and fix. This loop works with either auth method.

### Step 1: Get Failure Details

**With gh:**

```bash
# List recent workflow runs on this branch
gh run list --branch $(git branch --show-current) --limit 5

# View failed logs
gh run view <RUN_ID> --log-failed
```

**With git + curl:**

```bash
BRANCH=$(git branch --show-current)

# List workflow runs on this branch
curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/actions/runs?branch=$BRANCH&per_page=5" \
  | python3 -c "
import sys, json
runs = json.load(sys.stdin)['workflow_runs']
for r in runs:
    print(f\"Run {r['id']}: {r['name']} - {r['conclusion'] or r['status']}\")"

# Get failed job logs (download as zip, extract, read)
RUN_ID=<run_id>
curl -s -L \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/actions/runs/$RUN_ID/logs \
  -o /tmp/ci-logs.zip
cd /tmp && unzip -o ci-logs.zip -d ci-logs && cat ci-logs/*.txt
```

### Step 2: Reproduce service-gated failures before another push

If CI ran a test that the default local suite skipped because a service URL/environment variable was absent, do not burn push attempts by fixing only the first traceback and guessing at the next one. Read the active workflow, reproduce its service major version and environment variables with a disposable local service, apply migrations/setup in CI order, and run the complete service-gated test group together. Use frozen dependency resolution where supported so reproduction does not create unrelated lockfile drift.

After pushing the verified fix, resolve the newest workflow run and assert its `headSha` equals local `HEAD` before watching it. A green run for the prior commit is not evidence for the current fix.

### Step 3: Fix and Push

After identifying the issue, use file tools (`patch`, `write_file`) to fix it:

```bash
git add <fixed_files>
git commit -m "fix: resolve CI failure in <check_name>"
git push
```

### Step 4: Verify

Re-check CI status using the commands from Section 4 above.

### Auto-Fix Loop Pattern

When asked to auto-fix CI, follow this loop:

1. Check CI status → identify failures
2. Read failure logs → understand the error
3. Use `read_file` + `patch`/`write_file` → fix the code
4. `git add . && git commit -m "fix: ..." && git push`
5. Wait for CI → re-check status
6. Repeat if still failing (up to 3 attempts, then ask the user)

## 6. Merging

**With gh:**

```bash
# Squash merge + delete branch (cleanest for feature branches)
gh pr merge --squash --delete-branch

# Enable auto-merge (merges when all checks pass)
gh pr merge --auto --squash --delete-branch
```

**With git + curl:**

```bash
PR_NUMBER=<number>

# Merge the PR via API (squash)
curl -s -X PUT \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/pulls/$PR_NUMBER/merge \
  -d "{
    \"merge_method\": \"squash\",
    \"commit_title\": \"feat: add user authentication (#$PR_NUMBER)\"
  }"

# Delete the remote branch after merge
BRANCH=$(git branch --show-current)
git push origin --delete $BRANCH

# Switch back to main locally
git checkout main && git pull origin main
git branch -d $BRANCH
```

Merge methods: `"merge"` (merge commit), `"squash"`, `"rebase"`

### Enable Auto-Merge (curl)

```bash
# Auto-merge requires the repo to have it enabled in settings.
# This uses the GraphQL API since REST doesn't support auto-merge.
PR_NODE_ID=$(curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/pulls/$PR_NUMBER \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['node_id'])")

curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/graphql \
  -d "{\"query\": \"mutation { enablePullRequestAutoMerge(input: {pullRequestId: \\\"$PR_NODE_ID\\\", mergeMethod: SQUASH}) { clientMutationId } }\"}"
```

## 7. Complete Workflow Example

```bash
# 1. Start from clean main
git checkout main && git pull origin main

# 2. Branch
git checkout -b fix/login-redirect-bug

# 3. (Agent makes code changes with file tools)

# 4. Commit
git add src/auth/login.py tests/test_login.py
git commit -m "fix: correct redirect URL after login

Preserves the ?next= parameter instead of always redirecting to /dashboard."

# 5. Push
git push -u origin HEAD

# 6. Create PR (picks gh or curl based on what's available)
# ... (see Section 3)

# 7. Monitor CI (see Section 4)

# 8. Merge when green (see Section 6)
```

## Umbrella navigation: GitHub operations

This skill is the class-level entry point for GitHub work. Use the main PR lifecycle above for branch/commit/push/PR/CI/merge, and these labeled subsections for formerly separate GitHub operation skills:

### Authentication setup

Use `scripts/github-gh-env.sh` when a workflow needs a reusable auth/repo environment. Prefer `gh api user` as the real auth probe; fall back to `GITHUB_TOKEN` from the environment, `${HERMES_HOME:-$HOME/.hermes}/.env`, or `~/.git-credentials`. For first-time setup, choose among: `gh auth login` when an interactive browser is available; `echo "$TOKEN" | gh auth login --with-token && gh auth setup-git` on headless machines; or plain git credential storage/SSH keys when `gh` is unavailable. Always verify with `gh api user` or an authenticated `curl https://api.github.com/user`, not only cached status text.

When SSH git access works but `gh api repos/OWNER/REPO` returns `404` for a private repository, do not assume the repo is missing: the SSH key and the `gh` OAuth/PAT are separate credentials. For Actions dispatch or private-repo API work, refresh/login `gh` with appropriate scopes and require any organization SSO authorization shown by GitHub:

```bash
gh auth refresh -h github.com -s repo -s workflow -s read:org
# add admin:org only when the task genuinely needs org administration/SSO management
```

In a headless session, `gh auth refresh` prints a device code and waits. Send the user `https://github.com/login/device` plus the one-time code, press Enter for the CLI if needed, then verify the actual target repo and workflow access:

```bash
gh api repos/OWNER/REPO --jq .full_name
gh workflow list --repo OWNER/REPO
```

### Code review on GitHub

For PR review, gather metadata (`gh pr view`, changed files, checks), check out the PR locally for full-file context, run relevant local checks, then submit a structured review. Use `references/github-review-output-template.md` for the summary shape. If posting inline comments through the API, fetch the PR head SHA and use `POST /repos/{owner}/{repo}/pulls/{number}/reviews` for atomic multi-comment reviews. Request changes for critical/warning-level issues; approve only when no blocking issues remain.

### Issues and triage

For issue work, use `gh issue list/view/create/edit/comment/close` when available and REST `/repos/{owner}/{repo}/issues` as fallback. Keep bug and feature reports structured; starter bodies live in `templates/github-issue-bug-report.md` and `templates/github-issue-feature-request.md`. Remember that GitHub's issues endpoint also returns PRs, so filter out objects containing `pull_request` during REST triage.

When publishing a local Markdown file verbatim into an issue/PR comment, do not assume a file-tool wrapper returns raw content: some environments expose `LINE|CONTENT` prefixes. Prefer a raw `Path.read_text()` inside `execute_code`, write the assembled body through `write_file`, then PATCH via `gh api`. Re-read the comment and assert exact string equality; also reject any line matching `^\d+\|` before reporting success.

### Repository management

For clone/create/fork/release/secret/workflow operations, use `gh repo`, `gh release`, `gh secret`, and `gh workflow` first; fall back to REST plus git when needed. `references/github-api-cheatsheet.md` contains the compact endpoint map. When importing an existing local directory into a repo, write/verify `.gitignore` before `git add`, explicitly check staged files for secrets/runtime artifacts, run a cheap syntax/build check, then push and verify the remote branch/default branch.

### Publishing new local artifacts as private repositories

When the user asks to put a newly built artifact into one or more private repos, treat this as a delivery target change and complete it immediately rather than only describing commands. For split artifacts, create clean sibling directories per repo; copy only source, tests, lockfiles, docs, and deploy config; exclude `.venv`, `node_modules`, `__pycache__`, runtime data, local `.env`, and smoke artifacts. Run each split repo's tests/build/config checks after the copy, initialize git, stage only the clean tree, commit, then create with `gh repo create OWNER/NAME --private --source . --remote origin --push`. After push, verify `isPrivate=true`, default branch, remote URL, latest commit SHA, and clean local status. Use `references/private-repo-delivery.md` for the compact checklist.

Pitfalls: re-run tests in the split repo, not just the original workspace; README examples can be mangled by secret-redaction if they look like real token names, so use safe placeholder prose and re-read the file; deployable config placeholders need explicit validation guards so users do not accidentally deploy a reserved/example host.

## Absorbed GitHub operation subsections

### Codebase inspection

When the task is to inspect a repository rather than change it, use a lightweight inventory before reading deeply: identify languages, LOC, generated/vendor directories, test layout, package managers, CI config, and likely entry points. `pygount` or similar LOC tooling is useful for ratios, but treat counts as navigation aids rather than conclusions. Follow with targeted file reads and build/test discovery before proposing changes.

### Requesting or preparing code review

For pre-commit review requests, inspect the local diff, run cheap static checks/tests, look for secrets and dangerous artifacts, and auto-fix clear issues before asking a human reviewer. The useful handoff is a small summary of intent, files changed, risks, and exact verification commands/results; do not submit a review request with an unverified dirty tree.

## Narrowing a bloated PR diff by syncing main into a long-lived branch

When a freshly opened PR shows far more commits/files than the work you actually did (e.g. "51 commits, +3960/−798" for a focused feature), the cause is usually that **the feature branch carries prior unmerged lineage that the base branch does not yet contain**. Long-lived feature branches that accumulate several rounds of work, or branches where an earlier PR was squash-merged into `main` separately, drift this way.

Diagnose first, then sync:

```bash
# How many commits does the PR actually carry over main?
git rev-list --count origin/main..<branch>

# What's in the branch that main lacks, beyond your own commits?
git log --oneline origin/main..<branch>

# Is main already an ancestor (clean merge possible)?
git merge-base --is-ancestor origin/main <branch> && echo "up to date" || echo "diverged"
```

Often the prior work is ALREADY in `main` (a sibling PR landed it). Update `main`, then merge it into the branch so the PR diff collapses to just your real delta:

```bash
git fetch origin
git checkout main && git pull origin main      # fast-forward to landed work
git checkout <branch>
git merge main -m "merge: sync main into <branch> before <feature> PR"
```

After resolving conflicts and pushing, the GitHub PR **file diff** (`changed_files`, additions/deletions) narrows to your actual change set, even though the raw `commits` count stays high (it reflects branch lineage, not the diff). Judge PR scope by `gh api .../pulls/N --jq '.changed_files'` and the diffstat, not the commit count.

### Resolving conflicts from a squash-merged shared lineage

When `main` got your earlier work via a **squash merge** and your branch still has the granular commits, `git merge main` produces conflicts that are mostly **cosmetic** — same logic, different formatting (line wrapping, multiline vs single-line literals) — because a formatter ran on one side. Resolution pattern:

- For pure-formatting conflicts, take your `HEAD` side (it's the formatter-clean version you committed), e.g. multiline `ruff`/`black` output vs the upstream single-line form.
- For genuinely divergent assertions in tests, pick the side that matches the CURRENT implementation. Read the function under test before choosing — don't guess. (In this session a test conflict was resolved by checking that `render_new_key_message` actually emits a `"• model"` bullet, so the upstream stricter assertion was correct.)
- A file deleted on your side but modified on main (`DU` status) that you intentionally replaced: re-confirm the replacement exists, then `git rm <file>` to keep the deletion.
- Dead code reintroduced by the merge (a constant/helper the new architecture no longer uses): grep for references before keeping it; if nothing uses it, drop it during resolution rather than carrying it forward.

Always finish with the project's lint + full test suite before committing the merge — formatter-clean conflict resolution still needs `ruff check`/build to confirm no stray markers or syntax breakage survived. Then `git add` the resolved files explicitly and `git commit --no-edit` to complete the merge.


## Useful PR Commands Reference

| Action | gh | git + curl |
|--------|-----|-----------|
| List my PRs | `gh pr list --author @me` | `curl -s -H "Authorization: token $GITHUB_TOKEN" "https://api.github.com/repos/$OWNER/$REPO/pulls?state=open"` |
| View PR diff | `gh pr diff` | `git diff main...HEAD` (local) or `curl -H "Accept: application/vnd.github.diff" ...` |
| Add comment | `gh pr comment N --body "..."` | `curl -X POST .../issues/N/comments -d '{"body":"..."}'` |
| Request review | `gh pr edit N --add-reviewer user` | `curl -X POST .../pulls/N/requested_reviewers -d '{"reviewers":["user"]}'` |
| Close PR | `gh pr close N` | `curl -X PATCH .../pulls/N -d '{"state":"closed"}'` |
| Check out someone's PR | `gh pr checkout N` | `git fetch origin pull/N/head:pr-N && git checkout pr-N` |

---

## Pitfall: `gh pr edit`/`gh pr view --comments` fails on the deprecated Projects (classic) API

On some repos `gh pr edit` (and occasionally `gh pr create`) errors out citing the deprecated GitHub Projects classic API — the CLI tries to resolve project links and the API call 410s/errors, blocking the whole edit even when you only wanted to change the title/body. `gh pr view N --comments` is also affected: it hits the same `projectCards` field and exits with a GraphQL deprecation error instead of showing comments.

### Workaround for `gh pr edit` — REST PATCH

Bypass the CLI's project resolution and PATCH the PR directly:

```bash
gh api -X PATCH "repos/$OWNER/$REPO/pulls/N" \
  -f title="feat: new title" \
  -F body=@/tmp/pr_body.md      # -F @file reads body from a file (handles long markdown safely)
```

`gh api` reuses the existing `gh` auth, so no separate token wiring is needed. Use a `--body-file` / `-F body=@file` approach for multi-line bodies — heredoc the markdown to `/tmp/pr_body.md` first to avoid shell-quoting breakage.

### Workaround for `gh pr view --comments` — GraphQL reviewThreads

When `gh pr view N --comments` fails with the deprecation error, fetch PR comments and review threads via the GraphQL API directly:

```bash
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: N) {
      reviewThreads(first: 100) {
        nodes {
          path
          line
          comments(first: 5) {
            nodes { body author { login } path line }
          }
        }
      }
      comments(first: 50) {
        nodes { body author { login } }
      }
    }
  }
}' | python3 -m json.tool
```

`reviewThreads` captures inline code review comments (with file/line metadata); the top-level `comments` captures general PR conversation comments. Both are needed to get the full review feedback picture. Unicode escape sequences in the JSON output can be decoded with `python3 -c "print('\u041c\u0435...')"` or by piping through `python3 -c "import sys; print(sys.stdin.read())"` with proper encoding.

### Verification and curl fallback

Always re-read the PR body after editing to confirm the update landed, because the `gh pr edit` failure is silent past the error line:

```bash
gh api .../pulls/N --jq '.body' | grep -c <marker>
```

When `gh` itself is unavailable, use curl with jq for the same PATCH:

```bash
curl -s -X PATCH -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/pulls/N \
  -d "$(jq -n --rawfile b /tmp/pr_body.md '{body:$b}')"
```

`gh pr create --body-file` itself usually works (creation doesn't always hit the project path); it's the *edit* and *view --comments* paths that most reliably trip the deprecated API.
