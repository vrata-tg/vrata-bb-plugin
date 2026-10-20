# Repo-grounded feasibility review

Use this when a plan changes runtime architecture, persistence, migrations, or deployment behavior.

## Minimum inspection path

1. Read the full document and classify it before applying plan-grade checks.
2. Inspect every file the plan names plus the nearest callers/registration points.
3. For migrations, inspect:
   - current Alembic head and model metadata;
   - the actual production rollout script/workflow;
   - tests that encode migration admission or rejection;
   - deployment ordering and rollback behavior.
4. Trace each claimed implementation path through existing framework wiring: middleware order, handler registration, dependency injection, lifecycle hooks, and process topology.
5. Distinguish three outcomes:
   - **finding:** the repository makes the planned path impossible or leaves an architectural decision blocking implementation;
   - **residual risk:** impact depends on unavailable scale/runtime data;
   - **declared dependency:** already acknowledged by the document, so do not re-emit as a finding.

## Migration admission trap

A sentence such as “run a separate production schema rollout” is not a resolved deployment plan when the repository’s normal rollout rejects migration-bearing Git diffs. Check whether a real admission path exists. Also verify whether applying the migration out of band would actually let the subsequent code rollout pass: a Git-diff guard may continue rejecting the release even when the database is already upgraded.

When this is proven by rollout code and tests, it is normally a high-confidence blocking omission. Recommend one concrete plan change: add or extend a tested migration-admission flow that coordinates the schema step, application rollout, release pointer/state advancement, and rollback guarantees.

Conversely, do not demand a feature-specific migration workflow when the repository already has a generic, tested admission path that accepts an exact target SHA/head, verifies the live database head, preserves old-app/new-schema compatibility, and the plan names the existing rollout/runbook boundary. In that case, verify the new additive migration fits the established contract and suppress the finding; reusing the existing admission mechanism is the preferable outcome.

## Assumption checks for adversarial-only reviews

When the named persona is adversarial rather than feasibility, inspect the repository only to falsify load-bearing assumptions:

- **Outcome vs API capability:** an API proving that an edit/send succeeded does not prove the intended client-visible outcome (notification, chat preview, ordering, visibility while the UI is closed). Check authoritative platform docs, then require a client spike when the docs do not guarantee the outcome.
- **Temporal money semantics:** trace when a record is created, reserved, finalized, and marked finished. A period query on `created_at` can disagree with the moment the wallet is actually charged; cross-midnight and cross-month cases expose this assumption.
- **Polling cost:** compute the per-active-subject query rate from interval × queries per tick × lifetime. If materiality depends on missing production concurrency or table-size data, place it in `residual_risks` and ask for the baseline instead of promoting a theoretical scale finding.
- **Operational invariants:** verify claims such as “one process” against Compose/deploy topology. If true today but unenforced, record the future invariant as residual risk; do not re-emit an explicitly deferred multi-replica design as a new finding.

Keep persona boundaries strict: migration-admission or framework-wiring blockers remain feasibility territory unless the caller asked for that lens too.

## Enforceability of release gates

When a plan makes staging or production promotion depend on evidence, trace how that evidence is actually produced and admitted:

- Inspect the existing staging harness, workflow artifact shape, and production consumer. A sentence such as “run a real smoke” is not implementable when the repository only has API/database E2E and no way to drive the required external client actions.
- For client-visible Telegram/UI behavior, distinguish bot-side API success from a real user-client action. If the gate requires callbacks, user messages, preview/order behavior, or controlled restart observations, the plan must choose and name an executable mechanism: a user-client harness, or a manual canary with an exact-SHA/image attestation that the promotion workflow verifies.
- A mandatory GO/NO-GO gate must name its measurement scenario and decision threshold. “Acceptable latency,” “agreed budget,” or “bounded smoke window” without a number leaves promotion subjective and is an implementability finding when the plan itself makes that gate mandatory. This is different from speculative performance concern: the defect is the undefined decision rule, not an unproven claim that performance will be bad.
- Check whether the file that consumes the evidence is in scope. It is sufficient for an unchanged production workflow to consume a successful staging status only when staging itself cannot publish that status/artifact before the required evidence passes.

## Load-bearing runtime checks

When a plan makes an environment or hard-limit claim, verify the deployed artifact and the full data path rather than accepting a host-side unit test:

- **Deployment artifacts:** inspect the pinned production image, not only the Dockerfile or test host. For filesystem capabilities such as IANA timezone data, a read-only `docker image save` layer scan can prove whether the required file or package is present without starting a container. If the plan names a conditional prerequisite and artifact inspection settles the condition, require the implementation unit and file list to make that prerequisite concrete.
- **Trust-boundary normalization:** trace malformed input through the real adapter/client before the formatter or service under review. A fake returning a list directly may test a branch that production cannot reach when the real client wraps non-mapping JSON in a mapping; add the client boundary and its tests to the plan when normalization hides the state the runtime claims to handle.
- **Absolute output limits:** budget every unbounded variable field, not just repeated rows. A per-row cap cannot prove a final message-size invariant while URLs, externally supplied identifiers, model lists, or numeric strings remain unbounded. Require either enforced trust-boundary limits or an assembly-level fitting policy, plus a final rendered-output check.

These are findings only when repository inspection proves the mismatch. Do not promote hypothetical malformed payloads, oversized values, or missing packages without a reachable path or artifact evidence.

## Requirements/source-trace reviews

When the plan cites a live issue, ticket, or approved scope, treat that source as a separate contract from the current code:

1. Fetch the live source, including comments and current state; do not rely only on the plan's paraphrase.
2. Map every source behavior to a plan requirement, acceptance example, implementation unit, and test where applicable.
3. Separate three classes explicitly: source-required behavior, confirmed scope extensions, and plan-only additions. Current code proves feasibility or the existing bug; it does not silently expand scope.
4. Check internal guarantee language across requirements, decisions, tests, risks, and operational notes. A one-shot best-effort cleanup whose final failure still exits cannot also promise unconditional “eventual convergence”; correct the prose rather than adding a retry subsystem unless retries are required.
5. Express owner/lifecycle validity relative to the entry phase. A durable state such as `enabled + no owner` may be valid for initial send/recovery but superseding for an older tracked entry; avoid universal valid/invalid lists that contradict the state machine.
6. When a refactor says it preserves a cap, gate, or singleton property, trace the exact coordination primitive. Per-subject locks do not replace a process-wide admission lock; require the plan to retain the primitive and add the smallest cross-subject contention test.
7. Distinguish one active worker of a type from one application process overall. A singleton bot can still race with a separate API/worker process performing durable transitions, so database CAS may be justified without claiming multi-replica support.

For read-only source-trace reports, classify textual contradictions with one mechanically implied correction as fixes, codebase-pattern-resolved additions as proposed fixes, unresolved product tradeoffs as decisions, and verified coverage/boundaries as FYI observations. If the target is explicitly read-only, report fix candidates without applying them.

## Read-only command discipline

Repository review must not mutate tracked files. Package-manager wrappers may refresh lockfiles merely to run Python introspection. Prefer an already-created virtualenv executable directly, or use the package manager’s frozen/locked mode. For Python verification, prefer the existing environment with `PYTHONDONTWRITEBYTECODE=1` and disable test caches when supported. Capture `git status --short` before inspection and compare it afterward; if a review command changed a tracked file, restore only that proven self-induced change and verify status again.
