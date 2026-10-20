# Requirements and Source-Trace Audit

Use this checklist when a plan claims to implement a ticket, issue, requirements document, or a set of decisions refined in conversation.

## 1. Capture authoritative sources exactly

1. Fetch the live issue/requirements source, including comments and timeline when they can amend the body.
2. Record the exact user-facing copy, boundary words (`<`, `>`, inclusive/exclusive), counts, units, timezone labels, and examples.
3. Treat repository docs and current code as evidence of existing behavior, not as permission to silently expand the product requirement.
4. If the user supplied confirmed decisions outside the issue, list them separately. Do not blend them into issue-derived requirements.

## 2. Build forward provenance

Every plan requirement or key technical decision should be attributable to one of:

- `source` — quoted or directly paraphrased from the issue/origin document;
- `confirmed` — explicitly approved after the source was written;
- `invariant` — required by current code, security, privacy, data integrity, or deployment constraints;
- `proposed` — new product behavior needing a decision.

A plan that maps requirements to implementation units but does not map requirements back to sources has only backward implementation traceability, not full source traceability.

## 3. Compare exact UI contracts literally

When the source contains a sample card/message:

- embed the canonical sample or enumerate every literal string in the plan;
- compare headings, labels, punctuation, ordering, status icons, empty states, timestamp prefixes, emoji, and semantic formatting such as emphasis;
- identify existing additive fields (warnings, reserved amounts, key names, media facts, transitional statuses) and classify retain/remove as a decision;
- do not let a test say “exact issue copy” without providing the expected literal copy.

An `exact`/`literal` copy claim is closed only when the plan provides either a canonical rendered expected block or an exhaustive field/order/format contract. Repository-safe existing fields are **not** requirements invariants merely because they already render today: preserving an extra suffix, key name, media fact, or status annotation is a product decision unless an authoritative source requires it. If extras are confirmed, freeze their placement and display conditions separately from the canonical source block.

Golden tests for an exact-copy surface must compare the complete rendered text/HTML (with explicit variants for confirmed conditional additions), not only assert that headings or labels are contained. A single synonym such as `Updated` versus `Last updated`, a missing emoji, changed emphasis, or an unapproved additive line is a contradiction when the plan claims an exact copy contract.

## 4. Trace producers through adapters to consumers

For status, reason, quota, money, or external payload mappings:

1. Find every producer and persisted field.
2. Inspect service/client adapters that normalize the payload.
3. Inspect the final renderer/consumer.
4. Ensure tests enter through a production-shaped adapter path.

Pitfall: a fake can return a non-mapping payload directly while the real client wraps it into a mapping. The renderer test passes, but production reports a believable false state instead of “unavailable.” Test the envelope after real normalization, not only an impossible fake branch.

## 5. Validate transaction placement at callers

If a plan adds an isolation level or read-only snapshot inside a shared loader:

- inspect all callers before choosing the transaction boundary;
- determine whether any caller has already executed SQL or opened a transaction;
- scope database-specific isolation to the production dialect;
- retain a portable path for unit-test dialects;
- use a real database concurrency test as the authoritative proof.

The smallest correct design is often a caller-owned transaction on the one path that needs snapshot consistency, not a new abstraction or an unconditional transaction inside a shared helper.

## 6. Guard conditional dependency changes

If a dependency is “added only if runtime verification fails”:

- include the conditional manifest and lockfile in the plan’s file set;
- use frozen/constrained lock commands;
- assert unrelated locked packages do not move;
- verify the actual built artifact before deciding the dependency is needed.

This matters when a broad version range can silently upgrade an explicitly frozen package during relock.

## 7. Route findings

- `safe_auto`: literal source mismatch or editorial correction with one unambiguous answer.
- `proposed_fix`: implementability, adapter, transaction, test, or deployment gap with a minimal code-grounded correction.
- `decision`: additive behavior, user-facing semantics, or scope not approved by a source.
- `fyi`: confirmed coverage, grounded producer mapping, or residual observation requiring no plan change.

## Minimum report

Return:

1. verdict (`READY`, `NEEDS REVISION`, or `BLOCKED`);
2. confirmed-decision coverage;
3. findings grouped by routing class and priority;
4. source/code evidence and smallest suggested amendment;
5. read-only verification status, including whether the target was already untracked and whether tests were necessary.
