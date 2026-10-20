# Persistent-state and transaction integrity audit

Use this checklist when a plan changes durable state, ownership markers, transaction boundaries, retries, background side effects, or process-local supervisors.

## Review order

1. **Write the state machine from stored columns.** List legal durable states, transitional states, and schema-permitted but application-invalid states. Confirm recovery handles every combination.
2. **Trace every writer.** Include handlers, middleware, startup recovery, background loops, webhooks, cleanup paths, and supervisor restart logic. A shared helper is only shared if every writer routes through it.
3. **Separate serialization domains.** Process-local locks serialize only one process. Identify which guarantees come from PostgreSQL row locks/CAS and which require an operational singleton or distributed coordination.
4. **Define transaction ownership.** State whether a helper owns a fresh transaction or mutates a caller-owned session. Never allow it to commit unrelated pending work. Keep network calls outside row-lock transactions.
5. **Specify expected-state CAS, not merely a conditional update.** A claim must include the expected previous owner/state. Make retry idempotent by accepting the same already-persisted candidate, while rejecting a different winner.
6. **Separate expected owner from the pending candidate in process memory.** A network send can produce a candidate before its DB claim commits. The entry/supervisor contract must distinguish `expected_owner`, `candidate`, and claim phase: before commit the old/NULL owner is valid, after an ambiguous commit the same candidate is valid, and any third owner supersedes the entry. Otherwise restart logic either drops a valid persistence retry or resurrects a loser.
7. **Trace the loser path.** After CAS rejection, clear pending work, clean up the candidate best-effort, terminate the stale entry, and prevent supervisor resurrection while durable intent remains enabled for another owner.
8. **Audit owner mismatch, not only OFF.** A stale executor must stop when durable ownership becomes `NULL` or changes to another ID, even if the feature remains enabled.
9. **Track pre-clear values.** If cleanup needs the old durable value, capture it under the same row lock before clearing. Decide what happens when the process crashes after commit but before cleanup; without durable history, this is necessarily best-effort.
10. **Do not gate old-owner cleanup on the wrong winner.** In concurrent rotations, the actor that captured the prior owner may lose the candidate race. Once the ownership-clearing transaction commits, that actor should still normalize the prior owner when safe.
11. **Separate committed business data from post-commit effects.** Notifications, UI cleanup, and background tasks must not roll back settlement. Conversely, acknowledge that an in-process background task is not an outbox and can be lost after commit. Also name the earlier crash window between the business commit and a separate OFF/cleanup commit; a later duplicate may intentionally decline to replay that stale side effect.
12. **Check duplicate/retry semantics over time.** Retrying a post-commit OFF action on a later duplicate can incorrectly disable a newly re-enabled session. Without a durable side-effect marker, choose and document at-most-once versus potentially stale retry behavior.
13. **Validate lock ordering and deadlocks.** Keep row-lock transactions short and use a consistent order. If a financial/payment row is locked, commit it before acquiring unrelated user-state locks unless atomic coupling is explicitly required.

## Minimum evidence expected in a plan

- Exact legal durable states and recovery matrix.
- Expected value for every CAS transition.
- Terminal loser/superseded behavior, including supervisor behavior.
- Diagrams that preserve the same durable transitions as the prose: a replacement does not pass through `NULL` when its CAS expects the old owner, and a stale local owner stopping does not imply durable OFF.
- Operational topology assumption when locks are process-local.
- Crash windows accepted because no outbox/history/schema is being added.
- Clear ordering: durable commit, local cancellation, best-effort external cleanup, downstream work.

## Tests that catch false confidence

Use a real PostgreSQL targeted suite for row-lock/CAS claims; SQLite does not validate `FOR UPDATE` semantics.

An env-gated suite is not evidence until CI actually supplies its DSN and runs migrations. Inspect the workflow alongside the test: the environment-variable name must match, the database service must be started, and the command must execute the targeted file rather than silently skipping it. Prefer pointing one additional feature-specific variable at the existing CI PostgreSQL service over adding another database container.

Cover at minimum:

- two independent sessions racing activation and OFF;
- two candidates claiming one transitional state, with exactly one durable winner;
- stale replacement unable to overwrite a newer owner;
- retry after an ambiguous commit recognizing the same candidate as success;
- CAS loser not being restarted by a supervisor merely because durable intent is still enabled;
- external ownership change stopping and normalizing a stale loop;
- late external edit compensation, including cleanup failure still terminating the loop;
- recovery of schema-valid but application-invalid state;
- time-bounded concurrent operations to expose deadlocks;
- committed settlement surviving OFF/notification failure, with duplicate behavior documented.

## Severity guidance

Treat these as high priority:

- stale writers can overwrite a newer owner;
- loser tasks can resurrect through supervision;
- the plan claims one executor while only process-local locking exists;
- post-commit side effects are described as durable without an outbox;
- only SQLite tests are proposed for PostgreSQL locking guarantees.

Treat unavoidable crash windows as residual risks when the plan explicitly excludes the durable registry/outbox needed to close them.