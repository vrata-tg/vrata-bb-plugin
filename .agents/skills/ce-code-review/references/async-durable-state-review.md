# Async durable-state correctness review

Use this checklist for background refreshers, schedulers, bot loops, and other durable-intent/process-local-execution designs.

## Ordering and locks

- Trace from the real framework entrypoint, not only the manager.
- Find every `await` before the per-key lock. A callback acknowledgement before `enable()` can let a later update run `disable()` first, after which the older callback re-enables the feature.
- Verify both lock-acquisition orders. A race test where `enable` already owns the lock does not cover the inverse schedule.
- Check generation identity in loop execution, done callbacks, replacement, cancellation, and registry cleanup.

## Shutdown and supervision

- Inventory all in-flight work, including inline "first tick" work whose registry entry still has `task=None`.
- Confirm shutdown cancels and gathers every operation before clearing registries or closing transports.
- Prefer one registered lifecycle task with `initial_delay=0` over a special inline first iteration when this removes code and unifies cancellation/retry behavior.
- Read the framework shutdown source when its treatment of handler tasks is material; do not assume polling shutdown awaits concurrent update handlers.

## Failure classification and persistence

- Separate terminal edit failure, inaccessible destination, not-modified success, transient transport/server failure, and rate limiting.
- Honor structured retry metadata such as `retry_after`; generic capped exponential backoff may retry too early.
- After replacement send succeeds, retain the candidate ID in memory and retry persistence without resending.
- Trace failure/cancellation between send, candidate assignment, commit, and registry replacement.

## Query snapshots

One ORM session does not imply one database snapshot under `READ COMMITTED`.

For composite user-visible snapshots, test a concurrent commit between:

1. account/wallet state;
2. period aggregates;
3. recent rows.

Use one statement or an explicitly consistent short transaction when mixed old/new state would violate the feature contract.

## Migration and rollout

- Verify migration graph, fresh-schema replay, existing-schema upgrade, defaults, indexes, and rollback compatibility.
- Any manual schema rollout must acquire the same lock as routine application rollout if both touch the worktree, database, attestation marker, or release pointers.
- Re-check exact target/head after attestation; missing shared locking creates a TOCTOU gap even when each path is individually fail-closed.

## Minimum targeted tests

- Later event wins while the earlier handler is paused before manager entry.
- Shutdown cancels a blocked initial iteration before transport close.
- `retry_after` larger than ordinary/max backoff is respected.
- Finalize/reserve commits between snapshot statements cannot produce a mixed screen.
- Schema and routine rollout contend on one shared lock.
