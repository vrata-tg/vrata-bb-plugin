# Reliability Review Across Async, Payment, Provider, and Ops Branches

Load this reference when a review spans async/background jobs, payments, external providers, migrations, or deployment runbooks. It is a semantic failure-mode pass, not a style pass.

## 1. Build the real scope first

- Map every issue/branch to its exact worktree, base ref, changed-file list, and plan. Do not assume issue numbers are PR numbers.
- Read the staged diff for scope, then verify every surviving finding against the real worktree and real file line.
- For several pending migration branches, assemble their revisions together and compute the combined Alembic heads. Per-branch `alembic heads` can be green while the merge produces multiple heads.
- Treat runbook shell snippets as executable artifacts. Reproduce critical snippets under their declared `set -euo pipefail` mode.

## 2. Transaction and external-effect matrix

For each flow, write down this order explicitly:

1. local transaction begins;
2. remote side effect starts/finishes;
3. local rows/ledger are flushed;
4. DB commit is requested;
5. post-commit side effects run;
6. caller/provider receives acknowledgement.

Probe every boundary for both a definite failure and an ambiguous result.

### Ambiguous commit is not rollback

A client can receive an exception after PostgreSQL accepted the commit. Therefore this pattern is unsafe when a remote effect already exists:

```text
remote create -> local commit raises -> rollback -> remote revoke
```

The rollback cannot undo an already accepted commit. The revoke can leave a durable local key/payment record pointing to a dead remote object. Before compensation, reconnect and resolve durable state by a stable remote ID or idempotency key. Compensate only after proving the local commit did not land.

### Remote-first provisioning

Check the complete remote object graph, not only the final credential:

- team/account created, key creation fails;
- provider accepts a create but the client times out before receiving its ID;
- local persistence fails after remote success;
- compensation itself fails.

A revoke-key helper does not clean up a team created earlier. Prefer deterministic provider idempotency/reconciliation metadata over blind create-on-retry.

### Do not hold DB transactions across provider calls

A flushed insert plus one or more 10-second HTTP calls holds a pool connection and possibly uniqueness locks. Under provider degradation, concurrent onboarding can exhaust the DB pool. Persist a short provisioning state, release the transaction, perform external I/O, then attach the result in a short transaction.

## 3. Payment and webhook review

- Enforce amount/currency/min/max policy again at settlement. A limit checked only when rendering a client-controlled form can be bypassed by paying a different signed amount.
- Resolve same-operation and same-intent concurrency separately. A unique constraint is necessary but does not prove the losing transaction returns a controlled/idempotent result.
- Commit money, ledger, intent status, and notification event together. Run provider budget sync and user notification only after commit.
- Keep optional post-commit work off the provider acknowledgement path where possible. Provider retries should be driven by settlement outcome, not a slow notification or budget API.
- A body-size check after `await request.body()` does not limit memory. Check Content-Length when present and stream with a running byte limit.
- Before declaring a provider signature implementation wrong, fetch the current authoritative provider contract. Signature schemes and deprecated fields change; current docs beat remembered protocols.

## 4. Best-effort repair must actually make progress

When a payment/key/grant path logs a failed post-commit sync and relies on a sweeper:

- verify the sweeper eventually visits every eligible row;
- reject `LIMIT N` without a stable cursor/rotation;
- bound total sweep duration, not only each HTTP call;
- inspect ordering: a long optional sweep must not run before money reconciliation;
- distinguish transient provider failure, terminal configuration, invalid response, and internal DB/programming errors in metrics.

Serially applying a per-user timeout across a large batch can stall the entire worker tick. Calculate the worst-case batch duration and compare it to the intended cadence.

## 5. Async/background task lifecycle

- Startup recovery of all durable intents can create an O(N) thundering herd even when each user has only one task.
- Stagger recovery with bounded batches and jitter.
- For provider `Retry-After`/`retry_after`, wait at least the provider value; a local capped exponential backoff is not a substitute.
- Verify cancellation before first iteration, during inline first iteration, during persistence, and while a done-callback supervisor is spawning a successor.
- If process-local execution is backed by durable intent, state explicitly whether multiple replicas are supported. Without distributed ownership, two replicas can duplicate effects.

## 6. Worker-count reductions in async servers

When a change reduces Uvicorn/Gunicorn/LiteLLM workers, do not equate worker count with throughput alone:

- Inspect the **pinned runtime image/source**, not current upstream docs. Confirm whether `workers=1` bypasses the multiprocess supervisor and runs the server directly.
- Separate failure modes: a container restart policy recovers a process **exit**, but not a live event-loop/process **hang**. Check whether the removed supervisor previously pinged and replaced hung children.
- Render every Compose/environment overlay and inspect the effective command, restart policy, and healthcheck. An inherited one-line base change may affect staging and production identically.
- Trace deployment acceptance end to end: replacement strategy, local liveness, authenticated dependency/model checks, public checks, and post-start restart stability. A one-time readiness probe is not an ongoing hang watchdog.
- Determine whether deployment was already stop/start (`force-recreate`) or actually rolling. Do not blame a worker reduction for pre-existing non-rolling downtime.
- Treat an explicitly measured memory-for-redundancy choice as a residual risk when crash recovery and readiness remain intact. Report a finding only when the change breaks a stated availability contract or leaves a concrete unaccepted failure path.

A useful non-mutating probe is to run a short Python source inspection inside the pinned image and quote the exact supervisor branch (`workers > 1` versus direct `server.run()`), then verify the checkout status and diff are unchanged.

## 7. Deployment and rollback runbooks

For every mutation, require one shell control flow that owns both acceptance and rollback:

```text
acquire lock -> capture immutable baseline -> install rollback trap -> mutate -> accept -> disarm trap
```

A later rollback code block is not automatic rollback under `set -e`; the shell exits, releases its lock, and loses variables before reaching it.

Check:

- exact variable names under `set -u`;
- rollback after partial `compose up` or ingress reload;
- signals/SSH loss between mutation and pointer publication;
- whether an app-only rollback is compatible with an already migrated database;
- whether rollback acceptance checks old image IDs, working directory, health, and restart stability.

For migration-bearing deploys, exact-head admission alone does not prove the previous app can run against the new schema. Record backward compatibility or route to schema/data recovery instead of unconditional app rollback.

### Preserved-script rollback across older checkouts

A runbook that copies the current deploy script and then checks out an older revision preserves current safety logic, but it does **not** prove the script is compatible with the older tree.

- Enumerate every repository-relative file the preserved script opens (Compose overlays, mounted configs, dashboards, hooks, migration helpers), then verify each exists at the rollback ref with `git cat-file -e <ref>:<path>` or equivalent.
- Trace capability gates after checkout. An app-only rollback to a pre-observability release must not be blocked by monitoring config, container recreation, scrape acceptance, or dashboard checks that the old app cannot satisfy.
- Keep auxiliary stacks genuinely separate during app-only rollback: leave an existing monitoring/logging stack untouched and skip its config/pull/up/acceptance path. Report its expected degraded signal as a residual risk, not as a blocker to application recovery.
- Require one regression check that runs the preserved current script against a fixture/tree lacking the newly introduced auxiliary files. A same-revision happy-path deploy test cannot catch this compatibility break.
- Consolidate missing-file and missing-capability failures into one finding when they share the same root cause: the new auxiliary lifecycle was made unconditional during app-only rollback.

## 7. Verification and read-only hygiene

- Run the smallest targeted suites per branch, but inspect git status afterward.
- Some runners update lockfile metadata or create project virtualenvs during tests. Restore only runner-induced lockfile churn, remove newly created test environments/caches, and confirm every reviewed worktree is clean.
- A passing isolated branch suite does not prove cross-branch integration. Add a combined migration-graph check and any shared worker/provider contract checks.
- Findings must include exact current file lines, the concrete failure sequence, operational consequence, and smallest safe remediation. Put accepted limitations in residual risks rather than inflating them into findings.