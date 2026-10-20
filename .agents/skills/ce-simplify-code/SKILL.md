---
name: ce-simplify-code
description: "Simplify and refine recently changed code for clarity, reuse, quality, and efficiency while preserving behavior."
argument-hint: "[blank to simplify current branch changes, or describe what to simplify]"
---

## Hermes adaptation note

This skill was adapted from EveryInc/compound-engineering-plugin for Hermes Agent.

- `$ARGUMENTS` means the user's invocation text.
- When this upstream skill mentions Claude/Codex/Gemini/Pi question tools (`AskUserQuestion`, `request_user_input`, `ask_user`), use Hermes `clarify` when an answer is required.
- When it mentions `Task`, `Agent`, `spawn_agent`, `subagent`, or named `ce-*` reviewer/research agents, use Hermes `delegate_task`. Agent prompt files are preserved in the `compound-engineering` meta-skill under `references/agents/`; load the relevant file with `skill_view(name="compound-engineering", file_path="references/agents/<agent>.md")` before delegating when the prompt matters.
- When it shows Claude-style pre-resolution snippets such as `!` shell commands, treat them as instructions to gather that context with Hermes tools (`terminal`, `read_file`, `search_files`) rather than as literal markdown expansion.
- Some upstream flows depend on external CLIs/services (`agent-browser`, `Proof`, `Spiral`, `Slack`, `Gemini`, etc.); verify prerequisites before using them.

You are an engineer that is an expert at simplifying code with a specific focus on enhancing code clarity, consistency, and maintainability while preserving exact functionality. Your expertise lies in applying project-specific best practices to simplify and improve code without altering its behavior. You prioritize readable, explicit code over overly compact solutions.

Review the changed code for reuse, quality, and efficiency. Fix any issues found. Then verify affected behavior after actual edits. Reuse passing checks for unchanged code; pure documentation does not need executable tests.

## Step 1: Identify scope

Resolve the simplification scope in this order:

1. **If the user explicitly named a scope** (a file, a directory, "the function I just wrote", "the changes from this morning"), use that scope. Treat user-named scope as authoritative — do not widen it.
2. **Otherwise, in a git repository**, default to the diff between the current branch and its base branch (e.g., `git diff origin/main...` or against the configured upstream). This covers the common case of "simplify everything I've added on this feature branch before opening a PR." If the branch has no upstream or base ref, fall back to staged + unstaged changes (`git diff HEAD`).
3. **Outside a git repository or when no diff is available**, review the most recently modified files mentioned by the user or edited earlier in this conversation.

If none of the above produces a non-empty scope, stop and ask the user what to simplify rather than guessing.

## Step 2: Launch 3 review agents in parallel

Spawn the three reviewer agents below in a single message via the platform's subagent dispatch primitive — `Agent`/`Task` in Claude Code, `spawn_agent` in Codex, `subagent` in Pi via the `pi-subagents` extension. Pass each agent the full diff (or the resolved file set) so it has the complete context.

### Large-diff survival

When the diff is large (default threshold: >1,000 changed/diff lines), stage it once under `/tmp` as `full.diff` plus `files.txt` and pass paths rather than inline content. Reviewer prompts must require:

- start from diff hunks and use only targeted source reads needed to verify a concrete candidate;
- do not read whole large files, run package managers, run the full suite, or mutate the checkout;
- return at most five high-confidence behavior-preserving improvements and omit anything not provable within roughly twelve targeted inspection calls;
- prefer existing helpers/stdlib/deletion; do not turn two short call sites into a new abstraction merely to reduce textual duplication.

After every reviewer wave, run `git status --short`. Reviewer artifacts under `/tmp` are expected; project-file mutations are not. If a package runner touched only `uv.lock` metadata such as `exclude-newer`, restore that noise before evaluating findings. A timed-out reviewer contributes no finding; do not repeat the same unbounded pass.

**Model selection.** Use the platform's mid-tier model for these reviewers: `model: "sonnet"` in Claude Code, the equivalent mid-tier on Codex (`gpt-5.4-mini` as of April 2026) via `spawn_agent`, the equivalent on Pi via `subagent` from the `pi-subagents` extension. On platforms where the model-override parameter is unavailable or the model name is unrecognized, omit the override — a working pass on the parent model beats a broken dispatch.

**Permission mode.** Omit the `mode` parameter on the dispatch call so the user's configured permission settings apply.

### Agent 1: Code Reuse Reviewer

For each change:

1. **Search for existing utilities and helpers** that could replace newly written code. Look for similar patterns elsewhere in the codebase — common locations are utility directories, shared modules, and files adjacent to the changed ones.
2. **Flag any new function that duplicates existing functionality.** Suggest the existing function to use instead.
3. **Flag any inline logic that could use an existing utility** — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns are common candidates.

### Agent 2: Code Quality Reviewer

Review the same changes for hacky patterns:

1. **Redundant state**: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls
2. **Parameter sprawl**: adding new parameters to a function instead of generalizing or restructuring existing ones
3. **Copy-paste with slight variation**: near-duplicate code blocks that should be unified with a shared abstraction
4. **Leaky abstractions**: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries
5. **Stringly-typed code**: using raw strings where constants, enums (string unions), or branded types already exist in the codebase
6. **Unnecessary wrapper elements (framework-gated)**: in codebases that use a component-tree UI framework (React/JSX, Vue, Svelte, SwiftUI, Jetpack Compose, etc.), flag wrapper containers that add no layout value — check if inner component props (flexShrink, alignItems, etc.) already provide the needed behavior. Skip this rule entirely on codebases without such a framework.
7. **Nested conditionals**: ternary chains (`a ? x : b ? y : ...`), nested if/else, or nested switch 3+ levels deep — flatten with early returns, guard clauses, a lookup table, or an if/else-if cascade
8. **Unnecessary comments**: comments explaining WHAT the code does (well-named identifiers already do that), narrating the change, or referencing the task/caller — delete; keep only non-obvious WHY (hidden constraints, subtle invariants, workarounds)
9. **Dead code, unused imports, unused exports**: code paths no longer reachable, imports not referenced by the changed file, exports no longer consumed by any caller in the codebase. To verify "unused" across the codebase, prefer the project's existing unused-import/dead-code linter if configured (ESLint `no-unused-vars` / `unused-imports`, `knip`, `ruff F401`, `tsc --noEmit --noUnusedLocals`, `golangci-lint unused`, etc.). Otherwise prefer a structural search like `ast-grep` over plain text grep — grep produces false positives from string literals, comments, and substring matches in unrelated identifiers. Account for re-exports (`export * from`, barrel files), dynamic imports (`import()`, `require()`, template-string imports), and framework-specific exports (Next.js page exports, React Server Components, decorators). False positives here are higher-cost than missed catches; if uncertain, skip.

**Balance — avoid over-simplification.** Every flag above has a failure mode in the opposite direction; fewer lines is not the goal, faster comprehension is. Do not inline a helper that gives a concept a name, merge unrelated logic into one function, or remove an abstraction that exists for testability/extensibility or whose purpose you haven't confirmed is obsolete (check `git blame` for the original intent). If a proposed change would be longer or harder to follow than the original, don't flag it.

### Agent 3: Efficiency Reviewer

Review the same changes for efficiency:

1. **Unnecessary work**: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns
2. **Missed concurrency**: independent operations run sequentially when they could run in parallel
3. **Hot-path bloat**: new blocking work added to startup or per-request/per-render hot paths
4. **Recurring no-op updates**: state/store updates inside polling loops, intervals, or event handlers that fire unconditionally — add a change-detection guard so downstream consumers aren't notified when nothing changed. Also: if a wrapper function takes an updater/reducer callback, verify it honors same-reference returns (or whatever the "no change" signal is) — otherwise callers' early-return no-ops are silently defeated
5. **Unnecessary existence checks**: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error
6. **Memory**: unbounded data structures, missing cleanup, event listener leaks
7. **Overly broad operations**: reading entire files when only a portion is needed, loading all items when filtering for one

## Step 3: Fix issues

Wait for all three agents to complete. Aggregate their findings and fix each issue directly. If a finding is a false positive or not worth addressing, note it and move on. Do not argue with the finding or raise questions to the user, just skip it.

Before applying each fix, confirm it preserves behavior: same output for every input, same error behavior, and same side effects and ordering. If a fix can't clear that test, skip it — automated checks in Step 4 don't cover every behavior.

## Step 4: Verify behavior is preserved

The premise of this skill is that simplification preserves exact functionality. After applying fixes:

**Run typecheck and lint over the full project.** They are usually fast and catch the most common simplification regressions — broken imports, unused exports, dropped type narrowings, dead code other modules still reference.

**Run tests:**
- Run tests scoped to the changed paths. CI runs the full suite on PR — this local check is a fast signal, not the final guarantee. Match scope to blast radius; a 3-line simplification doesn't warrant a 20-minute test run.
- Broaden scope when the change has obvious wide reach — e.g., a heavily-imported utility was rewritten, or Agent 2's consolidation/dedup fixes modified shared code. This is a judgment call about ripple risk, not a mechanical rule.
- If the test runner has no scoping mechanism, run the full suite.

Surface any failure clearly with the failing check name and the relevant output. Do not relax assertions, weaken type signatures, or skip tests to make checks pass — that defeats the "preserves functionality" guarantee. Either fix the underlying break introduced by simplification, or revert the specific change that caused the regression.

If no test suite, lint, or typecheck is configured, state that explicitly in the summary; do not silently skip verification.

## Step 5: Summarize

Briefly summarize what was good vs improved and fixed, including which checks were run and their results. If there were no findings to act on, confirm the code didn't require any changes.
