---
name: hardening-menu
description: Evaluate optional mitigations before expanding an agreed change, or present a requested hardening menu. Defer unselected improvements unless a decision blocks core work.
---

# Hardening Menu

## Purpose

Discover realistic security, correctness, resilience, and fallback concerns
without automatically turning every concern into code.

Reachability determines whether a case is worth reporting.

Reachability alone does not determine whether a case is worth fixing.

A realistic case with negligible impact, expensive prerequisites, easy recovery,
or disproportionate implementation cost should normally be deferred. Mention
material deferred risks briefly; do not enumerate negligible cases by default.

## Authority boundary

Only the following may be implemented without a hardening decision:

- behavior explicitly requested by the user;
- explicit acceptance criteria;
- an existing public or persisted contract;
- behavior required for the normal supported path to work correctly;
- a reproduced regression named by the task or caused by the requested change;
- preservation of repository invariants in the affected path;
- code required to compile, start, or preserve the current basic contract.

Everything else that adds defensive behavior is a hardening candidate,
including:

- validation not required by the explicit contract;
- guards for malformed or adversarial input;
- security hardening;
- retries;
- fallbacks;
- degraded modes;
- compatibility paths;
- sanitization;
- normalization;
- rate limiting;
- duplicate suppression;
- timeout handling;
- recovery logic;
- extra error translation;
- extra logging intended only to diagnose rare failures;
- tests written solely for one of these optional behaviors.

A review finding is evidence to consider, not authority to change code.

Severity is not implementation authority.

## When to activate

Activate for an explicitly requested hardening assessment or when considering
optional mitigations beyond the agreed core. Touching billing, input, logging
or error handling alone does not require a separate menu.

Defer unselected candidates and continue core work. Ask only when the choice
blocks core work or changes the agreed contract. A requested standalone menu
returns recommendations for selection without implementing them.

## Discovery scope

Inspect the concrete code path involved in the requested change.

Do not perform a whole-repository security audit unless explicitly requested.

Trace:

- callers;
- producers of relevant values;
- trust boundaries;
- persisted state;
- external dependencies;
- normal failure paths;
- existing guards;
- framework and library guarantees.

Include material, realistic cases; investigate low-impact details only when
needed for a decision or explicitly requested.

Exclude cases that are unreachable under the current architecture.

Group cases that share the same trigger, impact, and mitigation. Do not create
a combinatorial list of every malformed value.

Limit the first menu to eight independent decisions. Merge closely related
cases or move lower-value cases into a grouped final row.

## Required analysis for every candidate

Assign a stable ID: H1, H2, H3, and so on.

For candidates requiring a decision, use the relevant fields below. For a
deferred item, a concise scenario, impact and reconsideration trigger suffice.

### 1. Category

Use one primary category:

- security;
- correctness;
- fallback;
- resilience;
- compatibility;
- observability.

### 2. Concrete scenario

Describe the exact state or sequence.

Do not use vague descriptions such as:

- input may be invalid;
- the dependency may fail;
- an attacker may abuse this;
- this could cause unexpected behavior.

Name:

- the controlled value or failed operation;
- the producer or caller;
- the path by which it reaches the affected code;
- the resulting behavior.

### 3. Trigger mode

Choose one:

- normal usage;
- unusual but supported usage;
- malformed input;
- authenticated adversarial usage;
- unauthenticated adversarial usage;
- dependency failure;
- operator error;
- race or timing condition;
- legacy or persisted state.

### 4. Trigger practicality

Choose one and justify it:

- trivial: one ordinary action or request is sufficient;
- easy: no special access; a small number of deliberate actions;
- moderate: requires authentication, coordination, timing, or sustained traffic;
- hard: requires privileged position, rare timing, large resources, or prolonged effort;
- impractical: reachable in theory but economically or operationally irrational.

For adversarial cases, state:

- required access level;
- number or rate of requests;
- required knowledge;
- required timing or coordination;
- attacker resource cost;
- capability gained by the attacker.

"User-controlled" is not a complete exploitability assessment.

### 5. Concrete impact

Describe what actually changes:

- confidentiality;
- integrity;
- availability;
- tenant isolation;
- billing accuracy;
- persisted data;
- user-visible correctness;
- recoverability;
- observability only;
- operational inconvenience only.

State explicitly what is not affected when that distinction matters.

Do not call something a security vulnerability without naming the gained
capability or denied property.

### 6. Scope and recovery

Report:

- affected users, tenants, requests, or processes;
- whether the effect persists;
- whether it self-recovers;
- whether an operator can detect it;
- whether recovery requires manual action;
- whether existing limits already bound the damage.

### 7. Mitigation options

Provide at most two options:

- Option A: smallest local containment;
- Option B: broader or more complete hardening, only when materially different.

Do not produce a patch or full pseudocode before selection.

Describe only the implementation shape necessary to estimate cost.

For fallback options, explicitly state whether the fallback:

- preserves the original contract;
- provides a documented degraded contract;
- returns plausible but incorrect data;
- hides the primary failure;
- makes diagnosis harder.

Failing explicitly is a valid zero-code alternative.

### 8. Diff cost

Estimate each mitigation separately.

Use ranges rather than false precision.

Report:

- production LOC added or changed;
- test LOC added or changed;
- number of files touched;
- number of new conditional branches;
- new public API surface;
- new configuration;
- new persisted state or schema;
- new dependency;
- ongoing maintenance burden.

Use this format:

```text
Prod: +8–14 LOC
Tests: +12–20 LOC
Files: 1
Branches: 1
Surface: no API, config, schema, state, or dependency changes
Maintenance: low; allowlist must be updated when supported values change
Estimate confidence: high
````

Do not include generated files, lockfile churn, formatting-only changes, or
comments in the LOC estimate.

A one-line guard plus twenty lines of tests is not a one-line mitigation.

A new branch is a permanent behavioral state and must be counted even when its
LOC cost is small.

### 9. Risk of implementing

State possible downsides of the mitigation:

* rejecting previously accepted values;
* masking upstream defects;
* changing failure semantics;
* introducing stale allowlists;
* creating inconsistent behavior across callers;
* making tests more coupled to implementation details;
* adding operational state;
* increasing maintenance cost.

### 10. Recommendation

Choose exactly one:

* implement;
* defer;
* skip;
* domain decision required.

Base the recommendation on:

* practical trigger difficulty;
* concrete impact;
* recoverability;
* mitigation size;
* new branches and behavioral states;
* maintenance burden;
* risk introduced by the mitigation.

Do not recommend implementation solely because a case is reachable or because
a security best practice mentions it.

### 11. Reconsideration trigger

For every `defer` or `skip` recommendation, state the smallest future change
that should cause the decision to be revisited.

Examples:

* the input becomes available to anonymous users;
* request rate becomes unbounded;
* the value begins affecting billing;
* the component starts storing sensitive data;
* monitoring resource usage becomes coupled to the main service;
* the failure is observed in production;
* another caller starts relying on the fallback contract.

## Output format

Begin with the estimated core implementation:

```text
Core implementation:
Prod: +20–35 LOC
Tests: +15–25 LOC
Files: 2
New branches: 1
```

Then render:

| ID | Category | Scenario | Trigger practicality | Concrete impact | Mitigation cost | Recommendation |
| -- | -------- | -------- | -------------------- | --------------- | --------------- | -------------- |

After the table, provide concise details for each candidate using the required
analysis fields.

Only if a blocking decision remains or the user requested a menu, finish with:

```text
Decision required.

Reply with one of:
- core only
- H1
- H1a, H3
- all recommended
- skip all
```

Do not recommend `all` as a default merely to avoid making a decision.

## Decision behavior

Before a decision on optional scope:

* continue authorized core implementation, tests and planning;
* do not implement optional code, tests or TODOs;
* do not add comments reserving future behavior;
* do not silently implement recommendations marked `implement`.

After the user decides:

* implement the core behavior;
* implement only explicitly selected candidate IDs and options;
* treat every unselected candidate as explicitly out of scope;
* do not replace a rejected mitigation with a different defensive mechanism;
* preserve the selected cost envelope unless code inspection reveals the
  estimate was materially wrong.

Ask again when the selected behavior, an agreed cost limit, or an unapproved
API, configuration, state, schema or dependency changes. Routine variance in
LOC, file counts or branches does not require renewed permission.

## Plan mode

When reviewing an implementation plan:

* separate required behavior from hardening candidates;
* remove unselected candidates from implementation units;
* remove unselected candidates from acceptance criteria;
* remove unselected candidates from mandatory test scenarios;
* remove unselected candidates from risks marked as requiring mitigation;
* keep them only in a non-authoritative `Unselected Hardening Candidates`
  section.

Only selected hardening IDs may become authoritative plan requirements.

Rejected IDs must be recorded in the plan's out-of-scope section when the plan
will be consumed by another autonomous agent.

## Review mode

When consuming code-review findings:

* preserve the reviewer's evidence;
* ignore the reviewer's auto-fix preference;
* independently evaluate trigger practicality, impact, mitigation cost, and
  risk of implementation;
* convert every finding not required by the explicit contract into a hardening
  candidate;
* fix findings already covered by core or selected IDs without asking again;
* defer other findings unless a decision blocks completion.

Regressions caused by the requested change and violations of the repository
invariants are core work, not optional hardening.

Highlight P0/P1. Apply core fixes under existing authorization; severity alone
does not authorize unrelated hardening.

## Final diff audit

Before finishing implementation, inspect the complete diff.

For every added:

* validation;
* guard;
* catch;
* retry;
* timeout;
* fallback;
* normalization;
* sanitization;
* compatibility path;
* recovery path;
* defensive test;

identify either:

* the explicit core requirement; or
* the approved hardening ID.

Remove every defensive addition that maps to neither.

Report the final mapping:

```text
Core:
- src/example.ts: required by requested behavior

Approved hardening:
- H1a: src/metrics.ts and tests/metrics.test.ts

Unselected hardening implemented:
- none
```