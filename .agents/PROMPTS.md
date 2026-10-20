# Agent entry prompts

Use these when a client does not discover repository Skills automatically.
AGENTS.md owns invariants; vrata-bb-plugin-dev owns routing and completion.
Earlier selections and authorizations remain valid across stages.

## Start or implement a change

Read AGENTS.md and .agents/skills/vrata-bb-plugin-dev/SKILL.md. Select the route
for this task. Before development, follow its working-tree checklist to fetch
and pull the repository, synchronize with current origin/main, and reread the
updated instructions. Inspect the affected files and complete the requested work.

## Plan only

Read .agents/skills/vrata-bb-plugin-dev/SKILL.md and
.agents/skills/ce-plan/SKILL.md. Return a verified plan; implementation is out
of scope. Use caller/pipeline mode when invoked by an existing workflow.

## Hardening decision

Read .agents/skills/hardening-menu/SKILL.md for the named plan or review.
Present the requested decision menu; apply the existing authorization boundary.

## Implement an approved plan

Read .agents/skills/vrata-bb-plugin-dev/SKILL.md and execute the named plan using
.agents/skills/ce-work/SKILL.md through Phase 2. Return the verified result to
the caller, which continues its remaining authorized stages.

## Review or simplify

Read .agents/skills/ce-code-review/SKILL.md for report-only review, or
.agents/skills/ce-simplify-code/SKILL.md for requested simplification. Follow
invariants and scope from AGENTS.md and vrata-bb-plugin-dev.

## Deliver a reviewed change

Follow the PR delivery boundary in .agents/skills/vrata-bb-plugin-dev/SKILL.md,
using .agents/skills/github-pr-workflow/SKILL.md for GitHub operations.
