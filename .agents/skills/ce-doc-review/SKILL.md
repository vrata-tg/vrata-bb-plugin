---
name: ce-doc-review
description: Review requirements or plan documents using parallel persona agents that surface role-specific issues. Use when a requirements document or plan document exists and the user wants to improve it.
argument-hint: "[mode:headless] [path/to/document.md]"
---

## Hermes adaptation note

This skill was adapted from EveryInc/compound-engineering-plugin for Hermes Agent.

- `$ARGUMENTS` means the user's invocation text.
- When this upstream skill mentions Claude/Codex/Gemini/Pi question tools (`AskUserQuestion`, `request_user_input`, `ask_user`), use Hermes `clarify` when an answer is required.
- When it mentions `Task`, `Agent`, `spawn_agent`, `subagent`, or named `ce-*` reviewer/research agents, use Hermes `delegate_task`. Agent prompt files are preserved in the `compound-engineering` meta-skill under `references/agents/`; load the relevant file with `skill_view(name="compound-engineering", file_path="references/agents/<agent>.md")` before delegating when the prompt matters.
- **Respect the live `delegate_task` concurrency limit.** Read the tool schema for the current session and dispatch no more reviewers than its advertised per-user limit. If the selected team exceeds that limit, split it into sequential batches; if a spawn still returns `Concurrency limit exceeded`, treat it as backpressure and retry the missing reviewers after the active batch completes. Keep each reviewer's persona prompt, schema, confidence-anchor rules, and the full document embedded in the task `context` — subagents have no session memory. Ask subagents to respond in the document's language (e.g. Russian) for the finding text fields.
- When it shows Claude-style pre-resolution snippets such as `!` shell commands, treat them as instructions to gather that context with Hermes tools (`terminal`, `read_file`, `search_files`) rather than as literal markdown expansion.
- Some upstream flows depend on external CLIs/services (`agent-browser`, `Proof`, `Spiral`, `Slack`, `Gemini`, etc.); verify prerequisites before using them.
- **Verify every headless auto-edit before reporting success.** After applying the single safe-auto patch pass, re-read the complete target document (not only the diff), confirm each intended replacement is present and the surrounding section still reads coherently, then inspect repository status scoped to the target. Report the absolute path and whether the document was already untracked; do not imply a Git diff exists for an untracked plan. This read-back is mandatory even for Markdown-only changes; tests are optional when no executable artifact changed.
- **Headless caller envelope should start with counts.** Before prose findings, emit a compact structured summary containing at least `document`, `reviewers_completed`, `fixes_applied`, `proposed_fixes_count`, `decisions_count`, `fyi_count`, `P0`, and `P1`. Counts are post-validation, post-dedup, and post-routing. This makes nested callers able to verify coverage without parsing the whole report.

# Document Review

Review requirements or plan documents through multi-persona analysis. Dispatches specialized reviewer agents in parallel, auto-applies `safe_auto` fixes, and routes remaining findings through a four-option interaction (per-finding walk-through, auto-resolve with best judgment, Append-to-Open-Questions, Report-only) for user decision.

## Interactive mode rules

- **Pre-load the platform question tool before any question fires.** In Claude Code, `AskUserQuestion` is a deferred tool — its schema is not available at session start. At the start of Interactive-mode work (before the routing question, per-finding walk-through questions, bulk-preview Proceed/Cancel, and Phase 5 terminal question), call `ToolSearch` with query `select:AskUserQuestion` to load the schema. Load it once, eagerly, at the top of the Interactive flow — do not wait for the first question site. On Codex, Gemini, and Pi this preload is not required.
- **The numbered-list fallback applies only when the harness genuinely lacks a blocking question tool** — `ToolSearch` returns no match, the tool call explicitly fails, or the runtime mode does not expose it (e.g., Codex edit modes where `request_user_input` is unavailable). A pending schema load is not a fallback trigger; call `ToolSearch` first per the pre-load rule. In genuine-fallback cases, present options as a numbered list and wait for the user's reply — never silently skip the question. Rendering a question as narrative text because the tool feels inconvenient, because the model is in report-formatting mode, or because the instruction was buried in a long skill is a bug. A question that calls for a user decision must either fire the tool or fall back loudly.

## Phase 0: Detect Mode

Check the skill arguments for `mode:headless`. Arguments may contain a document path, `mode:headless`, or both. Tokens starting with `mode:` are flags, not file paths — strip them from the arguments and use the remaining token (if any) as the document path for Phase 1.

If `mode:headless` is present, set **headless mode** for the rest of the workflow.

**Headless mode** changes the interaction model, not the classification boundaries. ce-doc-review still applies the same judgment about which tier each finding belongs in. The only difference is how non-safe_auto findings are delivered:

- `safe_auto` fixes are applied silently (same as interactive)
- `gated_auto`, `manual`, and FYI findings are returned as structured text for the caller to handle — no blocking-question prompts, no interactive routing
- Phase 5 returns immediately with "Review complete" (no routing question, no terminal question)

The caller receives findings with their original classifications intact and decides what to do with them.

Callers invoke headless mode by including `mode:headless` in the skill arguments, e.g.:

```
Skill("ce-doc-review", "mode:headless docs/plans/my-plan.md")
```

If `mode:headless` is not present, the skill runs in its default interactive mode with the routing question, walk-through, and bulk-preview behaviors documented in `references/walkthrough.md` and `references/bulk-preview.md`.

## Phase 1: Get and Analyze Document

**If a document path is provided:** Read it, then proceed.

**If no document is specified (interactive mode):** Ask which document to review, or find the most recent in `docs/brainstorms/` or `docs/plans/` using a file-search/glob tool (e.g., Glob in Claude Code).

**If no document is specified (headless mode):** Output "Review failed: headless mode requires a document path. Re-invoke with: Skill(\"ce-doc-review\", \"mode:headless <path>\")" without dispatching agents.

### Classify Document Type

Classify the document by reading its **content shape**, not its file path. Path is a tie-breaker hint, not the primary signal — a brainstorm-style doc placed under `docs/plans/` should still classify as `requirements`, and a plan-shaped doc under `docs/brainstorms/` should still classify as `plan`. The reviewers below operate differently depending on this classification, so misclassifying a plan-shaped doc as a requirements doc (or vice versa) produces noisy or under-scrutinized findings.

Use these signals to decide:

**`requirements` signals (what-to-build documents):**
- Frontmatter fields like `actors:`, `flows:`, `acceptance_examples:`, or `status:` carrying brainstorm-shaped values
- Section headings such as `Acceptance Examples`, `Actors`, `Key Flows`, `User Flows`, `Outstanding Questions`, `Resolve Before Planning`
- Numbered identifiers in the form `R1`, `R2`, `A1`, `F1`, `AE1` — requirement, actor, flow, and acceptance-example IDs
- Prose framing focused on user/business problem, behavior, scope boundaries, success criteria
- No implementation units, no per-unit file lists, no test scenarios attached to units

**`plan` signals (how-to-build documents):**
- Frontmatter fields like `type: feat|fix|refactor`, `origin: docs/brainstorms/...`
- Section headings such as `Implementation Units`, `Output Structure`, `Key Technical Decisions`, `Risks & Dependencies`, `System-Wide Impact`
- Numbered identifiers in the form `U1`, `U2` — implementation unit IDs
- Per-unit fields named `Goal`, `Files`, `Approach`, `Test scenarios`, `Verification`
- Repo-relative file paths to create/modify/test
- Prose framing focused on technical decisions, sequencing, and implementer-facing detail

**Tie-breaker rule.** When the content signals are mixed or sparse, fall back to path: `docs/brainstorms/` → `requirements`, `docs/plans/` → `plan`. When neither path location applies, treat the dominant content shape as authoritative; if shape is genuinely ambiguous, default to `requirements` (the more conservative classification — it activates fewer plan-specific feasibility checks).

Pass the classification result to each persona via the `{document_type}` slot in the subagent template. Personas read this and adapt their analysis accordingly.

### Ground Feasibility in the Repository

When feasibility review is requested, inspect the named implementation files and their real registration/call paths before accepting the plan's assumptions. For migration-bearing plans, also inspect the current migration head, production rollout workflow/script, and rollout tests: a document's claim that a separate schema rollout will occur is not sufficient if no tested admission path exists or the normal deploy still rejects the migration-bearing Git diff afterward. Keep repository inspection read-only, compare `git status --short` before and after, and avoid package-manager introspection commands that can refresh lockfiles unless frozen/locked mode is used.

See `references/repo-grounded-feasibility.md` for the inspection checklist, migration-admission trap, finding-vs-risk classification, and read-only command discipline.

For plans derived from a live issue, requirements document, or later confirmed decisions, also read `references/requirements-source-trace-audit.md`. It covers forward source provenance, literal UI-copy comparison, producer→adapter→consumer tracing, caller-owned transaction boundaries, conditional lockfile drift, and routing invented behavior as decisions rather than silently treating it as source-backed.

For plans that change time-window aggregates, recent-history queries, account snapshots, user-facing spend totals, or external quota/spend parsing, also read `references/data-query-integrity-review.md`. It covers mixed-horizon conditional aggregates, PostgreSQL multi-statement snapshot consistency, charged-status semantics, future-row handling, Decimal trust boundaries, owner/key privacy, and schema-free index judgment.

For plans that change durable ownership markers, row-lock/CAS transitions, process-local supervisors, cross-process OFF/cleanup behavior, or post-commit background effects, also read `references/persistent-state-transaction-audit.md`. It covers writer enumeration, transaction ownership, expected-owner versus pending-candidate state, supervisor resurrection, singleton assumptions, crash windows, diagram consistency, and proving that env-gated PostgreSQL tests actually execute in CI.

For security-sentinel reviews of plans that expose credentials, billing/account history, private UI facts, or external-service payloads, also use `references/security-sentinel-plan-audit.md`. It covers end-to-end authorization/IDOR proof, negative privacy canaries, producer-grounded error allowlists, escaping vs layout injection, hostile finite `Decimal` values, safe logging, and final-message limits after all wrappers.

For plans that remove or retire an existing screen, route, callback, command, or stateful flow, also use `references/feature-retirement-flow-audit.md`. It covers current-format removed callbacks versus unsupported-version callbacks, callback acknowledgement, middleware side effects, persisted FSM/session values, caller-proven deletion boundaries, future-plan dependencies, and intent-based test cleanup.

### Select Conditional Personas

Analyze the document content to determine which conditional personas to activate. Check for these signals:

**product-lens** -- activate when the document makes challengeable claims about what to build and why, or when the proposed work carries strategic weight beyond the immediate problem. The system's users may be end users, developers, operators, maintainers, or any other audience -- the criteria are domain-agnostic. Check for either leg:

*Leg 1 — Premise claims:* The document stakes a position on what to build or why that a knowledgeable stakeholder could reasonably challenge -- not merely describing a task or restating known requirements:
- Problem framing where the stated need is non-obvious or debatable, not self-evident from existing context
- Solution selection where alternatives plausibly exist (implicit or explicit)
- Prioritization decisions that explicitly rank what gets built vs deferred
- Goal statements that predict specific user outcomes, not just restate constraints or describe deliverables

*Leg 2 — Strategic weight:* The proposed work could affect system trajectory, user perception, or competitive positioning, even if the premise is sound:
- Changes that shape how the system is perceived or what it becomes known for
- Complexity or simplicity bets that affect adoption, onboarding, or cognitive load
- Work that opens or closes future directions (path dependencies, architectural commitments)
- Opportunity cost implications -- building this means not building something else

**design-lens** -- activate when the document contains:
- UI/UX references, frontend components, or visual design language
- User flows, wireframes, screen/page/view mentions
- Interaction descriptions (forms, buttons, navigation, modals)
- References to responsive behavior or accessibility

**security-lens** -- activate when the document contains:
- Auth/authorization mentions, login flows, session management
- API endpoints exposed to external clients
- Data handling, PII, payments, tokens, credentials, encryption
- Third-party integrations with trust boundary implications

**scope-guardian** -- activate when the document contains:
- Multiple priority tiers (P0/P1/P2, must-have/should-have/nice-to-have)
- Large requirement count (>8 distinct requirements or implementation units)
- Stretch goals, nice-to-haves, or "future work" sections
- Scope boundary language that seems misaligned with stated goals
- Goals that don't clearly connect to requirements

**adversarial** -- activate when the document contains a high-value challenge surface, not merely structural complexity. Routine plans with stated rationale are not by themselves an adversarial signal — premise/assumption work re-litigates settled questions when the only signal is "this plan is well-structured." Activate when ANY of the following holds:

- The document is a **requirements document** with 2+ challengeable claims (problem framing, solution selection, prioritization, predicted outcomes) -- premise scrutiny is core to the brainstorm phase
- The document touches a **high-stakes domain** -- auth, payments, billing, data migrations, privacy/compliance, external integrations, cryptography -- regardless of doc type or size
- The document **proposes a new abstraction, framework, or significant architectural pattern** -- regardless of doc type
- The document is a **plan with no `origin:` requirements doc** (greenfield bootstrap) -- premise wasn't validated upstream
- The document is a **plan that explicitly extends scope** beyond its origin requirements doc (new actors, new flows, deferred-then-restored features)
- The document contains an **explicit alternatives section** or unresolved tradeoffs -- adversarial helps stress-test the chosen direction

Do NOT activate adversarial on a routine plan document that derives from a validated origin requirements doc, stays within scope, and does not introduce high-stakes domains or new abstractions. The plan's structural decisions (more units, more rationale) are not by themselves adversarial signal -- those are the plan doing its job.

## Phase 2: Announce and Dispatch Personas

### Explicit single-persona headless reviews

When the caller requests `mode:headless` **and names one reviewer persona explicitly** (for example, `ce-adversarial-document-reviewer`), treat that as an intentional coverage override:

- run only the named persona; do not silently add the always-on coherence or feasibility reviewers;
- load that persona prompt and apply its own depth calibration (including caller-forced `Deep` when stated);
- repository inspection remains read-only and is used to test assumptions, not to broaden the review into other personas' territories;
- classify scale concerns that depend on unavailable production baselines as `residual_risks` or `deferred_questions`, not actionable findings;
- distinguish a premise/assumption defect from a feasibility blocker: cite code or platform documentation in `why_it_matters`, but keep `evidence` as direct document quotes required by the schema;
- if the caller requires schema-valid JSON only, emit exactly the reviewer envelope with no team announcement, coverage prose, markdown fence, or completion message; validate enums, title lengths, evidence arrays, and required `suggested_fix` fields before returning.

This override is narrower than the default team workflow below and applies only when both headless mode and an explicit persona are present.

### Announce the Review Team

Tell the user which personas will review and why. For conditional personas, include the justification:

```
Reviewing with:
- ce-coherence-reviewer (always-on)
- ce-feasibility-reviewer (always-on)
- ce-scope-guardian-reviewer -- plan has 12 requirements across 3 priority levels
- ce-security-lens-reviewer -- plan adds API endpoints with auth flow
```

### Build Agent List

Always include:
- `ce-coherence-reviewer`
- `ce-feasibility-reviewer`

Add activated conditional personas:
- `ce-product-lens-reviewer`
- `ce-design-lens-reviewer`
- `ce-security-lens-reviewer`
- `ce-scope-guardian-reviewer`
- `ce-adversarial-document-reviewer`

### Dispatch

Dispatch agents using **bounded parallelism** with the platform's subagent primitive (e.g., `Agent` in Claude Code, `spawn_agent` in Codex, `subagent` in Pi via the `pi-subagents` extension). Omit the `mode` parameter so the user's configured permission settings apply. Respect the current harness's active-subagent limit: queue selected reviewers, dispatch only as many as the harness accepts, and fill freed slots as reviewers complete. Treat active-agent/thread/concurrency-limit spawn errors as backpressure, not reviewer failure: leave the reviewer queued and retry after a slot frees. Record a reviewer as failed only after a successful dispatch times out/fails, or when dispatch fails for a non-capacity reason.

Each agent receives the prompt built from the subagent template included below with these variables filled:

| Variable | Value |
|----------|-------|
| `{persona_file}` | Full content of the agent's markdown file |
| `{schema}` | Content of the findings schema included below |
| `{document_type}` | "requirements" or "plan" from Phase 1 classification |
| `{document_path}` | Path to the document |
| `{origin_path}` | Value of the document's `origin:` frontmatter field if present, or the literal string `none` if absent. Personas that adapt on origin (product-lens, adversarial, scope-guardian) read this slot to gate technique suppression — they do NOT re-parse frontmatter themselves. Extract this once during Phase 1 reading. |
| `{document_content}` | Full text of the document |
| `{decision_primer}` | Cumulative prior-round decisions in the current session, or an empty `<prior-decisions>` block on round 1. See "Decision primer" below. |

Pass each agent the **full document** — do not split into sections.

### Decision primer

On round 1 (no prior decisions), set `{decision_primer}` to:

```
<prior-decisions>
Round 1 — no prior decisions.
</prior-decisions>
```

On round 2+ (after one or more prior rounds in the current interactive session), accumulate prior-round decisions and render them as:

```
<prior-decisions>
Round 1 — applied (N entries):
- {section}: "{title}" ({reviewer}, {confidence})
  Evidence: "{evidence_snippet}"

Round 1 — rejected (M entries):
- {section}: "{title}" — Skipped because {reason}
  Evidence: "{evidence_snippet}"
- {section}: "{title}" — Deferred to Open Questions because {reason or "no reason provided"}
  Evidence: "{evidence_snippet}"
- {section}: "{title}" — Acknowledged without applying because {reason or "no suggested_fix — user acknowledged"}
  Evidence: "{evidence_snippet}"

Round 2 — applied (N entries):
...
</prior-decisions>
```

Each entry carries an `Evidence:` line because synthesis R29 (rejected-finding suppression) and R30 (fix-landed verification) both use an evidence-substring overlap check as part of their matching predicate — without the evidence snippet in the primer, the orchestrator cannot compute the `>50%` overlap test and has to fall back to fingerprint-only matching, which either re-surfaces rejected findings or suppresses too aggressively. The `{evidence_snippet}` is the first evidence quote from the finding, truncated to the first ~120 characters (preserving whole words at the boundary) and with internal quotes escaped. If a finding has multiple evidence entries, use the first one; the rest live in the run artifact and are not needed for the overlap check.

Accumulate across all rounds in the current session. Skip, Defer, and Acknowledge actions all count as "rejected" for suppression purposes — each signals the user decided the finding wasn't worth actioning this round (Acknowledge is the no-fix-guard variant: the user saw a finding with no `suggested_fix`, chose not to defer or skip explicitly, and recorded acknowledgement instead; for round-to-round suppression that is semantically equivalent to Skip). Applied findings stay on the applied list so round-N+1 personas can verify fixes landed (see R30 in `references/synthesis-and-presentation.md`).

Cross-session persistence is out of scope. A new invocation of ce-doc-review on the same document starts with a fresh round 1 and no carried primer, even if prior sessions deferred findings into the document's Open Questions section.

**Error handling:** If an agent fails or times out, proceed with findings from agents that completed. Note the failed agent in the Coverage section with status markers (e.g., `✗ API error`, `✗ timeout`). Do not block the entire review on a single agent failure.

**Partial reviewer failure assessment:** After dispatch completes, evaluate whether to proceed with synthesis or recommend aborting:
- If 1-2 conditional reviewers fail but both always-on reviewers (coherence, feasibility) succeeded → proceed with synthesis, note the gap in Coverage
- If either always-on reviewer (coherence or feasibility) fails → recommend aborting and retrying, as these are foundational perspectives
- If security-lens or adversarial fail on a high-stakes document (auth, payments, billing, data migrations, privacy/compliance, external integrations, cryptography) → proceed but add prominent Coverage note that security review was incomplete and recommend re-running when API is available

When proceeding with partial results, add a Coverage note below the table explaining which perspectives are missing and whether the failure affects decision quality (e.g., "Security review incomplete due to API error. For high-stakes billing domain, recommend re-running when security-lens is available.").

**Dispatch limit:** Even at maximum (7 agents), use bounded parallel dispatch. If the harness cap is lower than the selected team size, queue the remainder and launch them as active reviewers complete.

## Phases 3-5: Synthesis, Presentation, and Next Action

After all dispatched agents return, read `references/synthesis-and-presentation.md` for the synthesis pipeline (validate, anchor-based gate, dedup, cross-persona agreement promotion, resolve contradictions, auto-promotion, route by three tiers with FYI subsection), `safe_auto` fix application, headless-envelope output, and the handoff to the routing question.

For the four-option routing question and per-finding walk-through (interactive mode), read `references/walkthrough.md`. For the bulk-action preview used by best-judgment routing, Append-to-Open-Questions, and walk-through `Auto-resolve with best judgment on the rest`, read `references/bulk-preview.md`. Do not load these files before agent dispatch completes.

---

## Included References

### Subagent Template

@./references/subagent-template.md

### Findings Schema

@./references/findings-schema.json
