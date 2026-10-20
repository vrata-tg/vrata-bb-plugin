# Alembic migration review probes

Use this when a review includes Alembic revisions, especially parallel feature branches or a dynamic initial migration that creates current ORM metadata.

## Minimum verification matrix

1. **Use the caller-provided base.** Inspect only the target against its listed base; do not silently substitute `main`.
2. **Check the isolated graph.** Run `alembic heads`; require exactly one head for the branch.
3. **Check the combined pending graph.** Collect migration revisions from all branches expected to merge together. Distinct files can merge cleanly in Git while still creating multiple Alembic heads when they share the same `down_revision`. Parse the combined revision set with Alembic `ScriptDirectory` or stage copies under `/tmp`; require one head.
4. **Exercise a true fresh upgrade.** Run one uninterrupted `alembic upgrade head` on an empty database. A test that directly calls only the new `upgrade()`, upgrades `0001` and then stamps past intermediate revisions, or starts from `Base.metadata.create_all()` does not prove full replay compatibility.
5. **Exercise an existing upgrade.** Build a production-shaped schema at the exact prior revision, upgrade to head, and verify existing rows, defaults, nullability, indexes, constraints, and any backfill.
6. **Check ORM parity after upgrade.** Run `alembic check` against the upgraded existing schema. This catches path-dependent drift such as a migration using `sa.Uuid()` while the model uses a project `GUID()` type. Verify all supported dialects; PostgreSQL-equivalent types can still drift on SQLite.
7. **Probe downgrade semantics.** Run downgrade and re-upgrade on disposable data. Report whether rows/columns are destroyed, whether downgrade is intentionally a no-op, and whether Alembic's version can move backward while additive objects remain.
8. **Inspect hot-table DDL.** Standard PostgreSQL `CREATE INDEX` blocks writers. Require `CONCURRENTLY`/online DDL or an explicit writer-quiesce step; merely saying “maintenance window” is not enough when the runbook leaves services running.
9. **Re-check the worktree.** Tests and probes must leave project worktrees clean; databases and assembled graphs belong under `/tmp`.

## Dynamic initial migration pitfall

Some repositories implement `0001_initial` as `Base.metadata.create_all()`. Fresh replay then depends on *current* models, not historical schema. Later migrations may encounter objects already created by `0001`, while intermediate migrations can temporarily add legacy objects that a later migration must remove. Inspector guards on the newest migration alone do not prove the whole chain works.

Always prefer the smallest authoritative probe:

- Empty DB -> `alembic upgrade head` -> `alembic current` -> `alembic check`.
- Prior-head production-shaped DB -> `alembic upgrade head` -> data/schema assertions -> `alembic check`.
- Combined pending revision directory -> Alembic head enumeration.

Do not treat a passing direct migration unit test as evidence for any of these three checks.