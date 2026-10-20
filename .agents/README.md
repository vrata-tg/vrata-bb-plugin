# Repository agent package

This directory contains the complete repository-local agent workflow. Root
`AGENTS.md` is the always-on entrypoint; this package carries the real skills,
reviewer prompts, references, templates, and helper scripts required after
cold start.

## Development routing

Read `skills/vrata-bb-plugin-dev/SKILL.md` for task sizing, optional hardening,
verification and delivery boundaries. It owns the sequence; read its selected
packages at the relevant stage. Small changes do not require the full pipeline.
Use `PROMPTS.md` when the client does not discover skills automatically.

This package is copied from `vrata-vscode` and based on the main
`ai-billing-gateway` repository. Provenance, file counts and local adaptations
are recorded in `VENDORED.md`. Server
operations and the gateway context-index script are outside this package.

## Capability mapping for any agent

Vendored skills use capability names from several agent runtimes. Translate
rather than skipping work:

| Skill wording                                               | Required capability                                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill_view(name, file_path)` or “load skill”               | Read the named repository-local `skills/<name>/SKILL.md` or its relative reference file.                                                                    |
| `delegate_task`, `Task`, `Agent`, `spawn_agent`, `subagent` | Run an isolated worker when available; otherwise review locally in read-only mode, disclose lack of independence, and do not wait for unavailable capacity. |
| `clarify`, `AskUserQuestion`, `request_user_input`          | Ask only for a missing decision that blocks the task or changes its agreed contract; preserve earlier authorization.                                        |
| `read_file`, `Read`                                         | Read the exact repository file without modifying it.                                                                                                        |
| `search_files`, `Grep`, `Glob`                              | Search repository paths/content before broad reading.                                                                                                       |
| `terminal`, `Bash`                                          | Execute the exact command with its exit status visible.                                                                                                     |
| `patch`, `Edit`, `Write`                                    | Apply the smallest explicit file change and inspect the resulting diff.                                                                                     |
| `gh` or GitHub tools                                        | Use GitHub CLI/API, then read back the PR/run/ref before claiming success.                                                                                  |
| browser/computer-use tool                                   | Drive a real browser only when the task requires UI or live web verification.                                                                               |

Project-specific skill aliases:

- `ce-work` is invoked here only through its documented Phase 2 boundary, so
  its internal shipping phase does not run. If a caller explicitly continues
  into Phase 3–4 and it names
  `ce-commit` or `ce-commit-push-pr`, load `skills/github-pr-workflow/SKILL.md`;
  that package owns commit, push, PR, and configured CI on the exact head in
  this repository.
- If a skill names `ce-worktree`, use native `git worktree` commands when a task-owned
  worktree is needed. No additional wrapper skill is
  required.

When a skill mentions an unavailable optional integration such as Slack, Figma,
or a proprietary reviewer, mark that branch unavailable and continue only when
it is not part of the requested acceptance contract. The route and completion
boundary in `skills/vrata-bb-plugin-dev/SKILL.md` determine which stages apply.

## Package inventory

- `skills/vrata-bb-plugin-dev/`: project sequencing and non-negotiable gates.
- `skills/ce-plan/`: planning workflow and references.
- `skills/ce-doc-review/`: plan/document review workflow and schemas.
- `skills/hardening-menu/`: plan/review hardening decision gates.
- `skills/ce-work/`: implementation workflow and shipping references.
- `skills/ce-simplify-code/`: simplification/Ponytail review procedure.
- `skills/ce-code-review/`: report-only code review, validators, and schemas.
- `skills/compound-engineering/`: exact reviewer/researcher persona prompts.
- `skills/github-pr-workflow/`: GitHub, PR, CI, templates, and helper scripts.
- `PROMPTS.md`: direct entry prompts for clients without native skill discovery.
- `VENDORED.md`: source provenance and exact tree digests.

The vendored Compound Engineering catalog describes its upstream distribution,
not the installed inventory above. Load only packages present here; do not
assume an optional skill or integration is installed because the catalog lists it.

## Client support

- `AGENTS.md` is the primary discovery surface.
- `.bb/AGENTS.md` directs bb sessions to the canonical root instructions.
- Root `CLAUDE.md` imports `AGENTS.md`; root `GEMINI.md` points to it. These are entrypoints;
  client CLI discovery has not been live-tested in this repository.
- Other clients read `AGENTS.md`, use a prompt from `PROMPTS.md`, and apply the
  capability mapping above.

## Maintenance

- Do not shorten or rewrite vendored packages during normal repository work.
- Refresh a package by replacing its complete directory, re-running credential
  scanning and source/destination byte+mode comparison, then updating
  `VENDORED.md`.
- Keep product/runtime facts in live code and current repository docs.
- Never add credentials, host state or generated artifacts to this package.

Reference formats:

- https://agents.md/
- https://agentskills.io/specification
