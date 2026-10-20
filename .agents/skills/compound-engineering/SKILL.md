---
name: compound-engineering
description: "Hermes adaptation of EveryInc Compound Engineering plugin: 39 CE workflow skills plus preserved CE agent prompts. Use to discover installed ce-* skills, understand Hermes-specific limitations, or load CE agent prompt references for delegate_task."
version: 3.12.0
author: EveryInc, adapted for Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [compound-engineering, every, planning, code-review, workflow, external-plugin-adaptation]
    homepage: https://github.com/EveryInc/compound-engineering-plugin
---

# Compound Engineering for Hermes

Installed from `EveryInc/compound-engineering-plugin` version `3.12.0`, revision `4719dc509fdc45656a830e3ed6060f674e206076`.

This is a Hermes adaptation of an upstream Claude/Codex/Cursor-style plugin. It is installed as normal Hermes skills under the `compound-engineering` category, not as a native Hermes plugin with hooks/tools.

## Hermes mapping

- Upstream slash commands like `/ce-plan` are available as Hermes skills by name, e.g. load `ce-plan` with `skill_view(name="ce-plan")` or invoke it naturally in a new session.
- `$ARGUMENTS` in upstream docs means the user's invocation text.
- Upstream blocking-question tools (`AskUserQuestion`, `request_user_input`, `ask_user`) map to Hermes `clarify`.
- Upstream subagent primitives (`Agent`, `Task`, `spawn_agent`, `subagent`) map to Hermes `delegate_task`.
- CE agent prompt files are preserved here under `references/agents/`. Load the needed prompt before delegation, e.g. `skill_view(name="compound-engineering", file_path="references/agents/ce-security-reviewer.md")`.
- Claude-style `!` pre-resolution snippets are not automatically expanded by Hermes; gather that context with Hermes tools instead.

## Installed workflow skills

- `ce-agent-native-architecture` — Build applications where agents are first-class citizens. Use this skill when designing autonomous agents, creating MCP tools, implementing self-modifying systems, or building apps where features are outcomes achieved by
- `ce-agent-native-audit` — Run comprehensive agent-native architecture review with scored principles
- `ce-brainstorm` — Explore requirements and approaches through collaborative dialogue, then write a right-sized requirements document. Use when the user says "let''s brainstorm", "what should we build", or "help me think through X", presen
- `ce-clean-gone-branches` — Clean up local branches whose remote tracking branch is gone. Use when the user says "clean up branches", "delete gone branches", "prune local branches", "clean gone", or wants to remove stale local branches that no long
- `ce-code-review` — Structured code review using tiered persona agents, confidence-gated findings, and a merge/dedup pipeline. In interactive mode it applies safe, verified fixes and commits them when the working tree is clean (it never pus
- `ce-commit` — Create a git commit with a clear, value-communicating message. Use when the user says "commit", "commit this", "save my changes", "create a commit", or wants to commit staged or unstaged work. Produces well-structured co
- `ce-commit-push-pr` — Commit, push, and open a PR with an adaptive, value-first description that scales in depth with the change. Use when the user says "commit and PR", "ship this", "create a PR", or "open a pull request". Also handles descr
- `ce-compound` — Document a recently solved problem to compound your team's knowledge or CONCEPTS.md, the project's shared domain vocabulary.
- `ce-compound-refresh` — Refresh stale learning and pattern docs under docs/solutions/ by reviewing them against the current codebase, then updating, consolidating, or deleting drifted ones. Use when the user asks to "refresh my learnings", "aud
- `ce-debug` — Systematically find root causes and fix bugs. Use when debugging errors, investigating test failures, reproducing bugs from issue trackers (GitHub, Linear, Jira), or when stuck on a problem after failed fix attempts. Als
- `ce-demo-reel` — Capture a visual demo reel (GIF, terminal recording, screenshots) for PR descriptions. Use when shipping UI changes, CLI features, or any work with observable behavior that benefits from visual proof. Also use when asked
- `ce-dhh-rails-style` — This skill should be used when writing Ruby and Rails code in DHH's distinctive 37signals style. It applies when writing Ruby code, Rails applications, creating models, controllers, or any Ruby file. Triggers on Ruby/Rai
- `ce-doc-review` — Review requirements or plan documents using parallel persona agents that surface role-specific issues. Use when a requirements document or plan document exists and the user wants to improve it.
- `ce-dogfood-beta` — [BETA] Dogfood the active branch end-to-end as a QA engineer. Diffs the branch against main, builds an exhaustive browser test matrix of every change (full user journeys, not just features), drives the app with agent-bro
- `ce-frontend-design` — Build web interfaces with genuine design quality, not AI slop. Use for any frontend work - landing pages, web apps, dashboards, admin panels, components, interactive experiences. Activates for both greenfield builds and
- `ce-gemini-imagegen` — This skill should be used when generating and editing images using the Gemini API (Nano Banana Pro). It applies when creating images from text prompts, editing existing images, applying style transfers, generating logos
- `ce-ideate` — Generate and critically evaluate grounded ideas about a topic. Use when asking what to improve, requesting idea generation, exploring surprising directions, or wanting the AI to proactively suggest strong options before
- `ce-optimize` — Run metric-driven iterative optimization loops -- define a measurable goal, run parallel experiments, measure each against hard gates or LLM-as-judge scores, keep improvements, and converge on the best solution. Use when
- `ce-plan` — Create structured plans for multi-step tasks -- software features, research workflows, events, study plans, or any goal that benefits from breakdown. Also deepens existing plans with interactive sub-agent review. Use whe
- `ce-polish` — Start the dev server, open the feature in a browser, and iterate on improvements together. Manual invocation only — type /ce-polish to run it.
- `ce-product-pulse` — Generate a time-windowed pulse report on what users experienced and how the product performed - usage, quality, errors, signals worth investigating. Use when the user says 'run a pulse', 'show me the pulse', 'how are we
- `ce-promote` — Draft user-facing announcement and marketing copy for a feature that just shipped — an X post or thread, a changelog blurb, a LinkedIn post, an email, a blog intro, or a short demo script. Spiral-agnostic by default; voi
- `ce-proof` — Run human-in-the-loop review loops over markdown via Proof (proofeditor.ai) — share, view, comment on, edit, and sync collaborative docs. Use when the user says "view this in proof", "share to proof", "HITL this doc", or
- `ce-release-notes` — Summarize recent compound-engineering plugin releases, or answer a specific question about a past release with a version citation. Use when the user types `/ce-release-notes` or asks "what changed in compound-engineering
- `ce-report-bug` — Report a bug in the compound-engineering plugin
- `ce-resolve-pr-feedback` — Resolve PR review feedback by evaluating validity and fixing issues in parallel. Use when addressing PR review comments, resolving review threads, or fixing code review feedback.
- `ce-riffrec-feedback-analysis` — Riffrec product-feedback workflow. ALWAYS load when the user posts a `riffrec-*.zip`, a bundle with `session.json` + `events.json` + `recording.webm` + `voice.webm`, a video/audio recording for product feedback, or asks
- `ce-sessions` — Search and ask questions about coding agent session history across Claude Code, Codex, and Cursor. Use when asking what was worked on, what was tried before, how a problem was investigated across sessions, what happened
- `ce-setup` — Diagnose and configure compound-engineering environment. Checks CLI dependencies, plugin version, and repo-local config. Offers guided installation for missing tools. Use when troubleshooting missing tools, verifying set
- `ce-simplify-code` — Simplify and refine recently changed code for clarity, reuse, quality, and efficiency while preserving behavior.
- `ce-slack-research` — Search Slack for interpreted organizational context -- decisions, constraints, and discussion arcs -- and produce a synthesized research digest with cross-cutting analysis. Use when the user says 'search slack for', 'wha
- `ce-strategy` — Create or maintain STRATEGY.md - the product's target problem, approach, users, key metrics, and tracks of work. Use when starting a new product, updating direction, or when prompts like 'write our strategy', 'update the
- `ce-test-browser` — Run browser tests on pages affected by current PR or branch
- `ce-test-xcode` — Build and test iOS apps on simulator using XcodeBuildMCP. Use after making iOS code changes, before creating a PR, or when verifying app behavior and checking for crashes on simulator.
- `ce-update` — |
- `ce-work` — Execute work efficiently while maintaining quality and finishing features
- `ce-work-beta` — [BETA] Execute work with external delegate support. Same as ce-work but includes experimental Codex delegation mode for token-conserving code implementation.
- `ce-worktree` — Create an isolated git worktree for parallel feature work or PR review. Use when starting work that should not disturb the current checkout, or when `ce-work` or `ce-code-review` offers a worktree option.
- `lfg` — Run the full autonomous engineering pipeline end-to-end (plan, work, code review, test, commit, push, open PR, watch CI, fix CI failures until green). Use only when the user explicitly requests hands-off execution of a s

## Preserved agent prompt files

See `references/agents-index.md`.

## Upstream traceability

- Source: https://github.com/EveryInc/compound-engineering-plugin
- Version: `3.12.0`
- Revision: `4719dc509fdc45656a830e3ed6060f674e206076`
- License copied to `references/upstream/LICENSE`
- Upstream plugin README copied to `references/upstream/README.md`

## Known limitations

- This adaptation does not add Hermes-native slash commands, hooks, or new tool schemas.
- Review/planning workflows that expect named CE agents require explicit `delegate_task` orchestration using the preserved agent prompts.
- External-service skills still require their original CLIs/API keys/services.
