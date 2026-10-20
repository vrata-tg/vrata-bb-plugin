# Strict read-only verification

Use this when `mode:agent` or the caller forbids project/repository mutation.

## Keep test artifacts outside the checkout

- Run the existing interpreter directly; avoid package runners that may refresh lockfiles.
- Disable pytest cache and redirect bytecode/temp files under the review run directory.
- Create the pytest temp root **before** setting `PYTEST_DEBUG_TEMPROOT`; pytest expects its parent to exist.

```bash
RUN_DIR=/tmp/compound-engineering/ce-code-review/<run-id>
mkdir -p "$RUN_DIR/pytest-focused"
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPYCACHEPREFIX="$RUN_DIR/pycache-focused" \
PYTEST_DEBUG_TEMPROOT="$RUN_DIR/pytest-focused" \
/path/to/.venv/bin/python -m pytest -p no:cacheprovider -q /absolute/test/path
```

Use a separate temp root and pycache prefix for concurrent or repeated runs.

## Verify the checkout stayed unchanged

Capture before dispatch, then compare after all reviewer/test waves:

```bash
git -C /absolute/repo status --short > "$RUN_DIR/status-before.txt"
git -C /absolute/repo diff -U10 "$BASE" > "$RUN_DIR/full.diff"
# ... review and verification ...
git -C /absolute/repo status --short > "$RUN_DIR/status-after.txt"
git -C /absolute/repo diff -U10 "$BASE" > "$RUN_DIR/full-after.diff"
cmp -s "$RUN_DIR/status-before.txt" "$RUN_DIR/status-after.txt"
cmp -s "$RUN_DIR/full.diff" "$RUN_DIR/full-after.diff"
```

For an explicit staged-only review, snapshot the index and unstaged work independently. Porcelain status alone cannot detect a staged-content rewrite that leaves the same path/status letters:

```bash
git -C /absolute/repo diff --cached -U10 "$BASE" > "$RUN_DIR/staged-before.diff"
git -C /absolute/repo diff > "$RUN_DIR/unstaged-before.diff"
# ... review and verification ...
git -C /absolute/repo diff --cached -U10 "$BASE" > "$RUN_DIR/staged-after.diff"
git -C /absolute/repo diff > "$RUN_DIR/unstaged-after.diff"
cmp -s "$RUN_DIR/staged-before.diff" "$RUN_DIR/staged-after.diff"
cmp -s "$RUN_DIR/unstaged-before.diff" "$RUN_DIR/unstaged-after.diff"
```

Also verify `git rev-parse HEAD` is unchanged. Keep all comparison outputs under the run directory.

### Avoid compacted diff output in byte-for-byte checks

Some Hermes shells route large `git diff` output through RTK compaction, even when the command is piped to `sha256sum` or a Python hasher. The compacted stream can append markers such as `[full diff: rtk git diff --no-compact]`, producing a false mismatch while the index is unchanged.

When exact bytes matter, explicitly request the unabridged stream:

```bash
rtk git diff --no-compact --cached --patch -U10 "$BASE" > "$RUN_DIR/staged-after.diff"
```

If RTK is unavailable, use the normal `git diff` command. Before treating a mismatch as concurrent mutation, verify the compared index object IDs (`git ls-files -s <paths>`) and inspect the stream for compaction markers.

## Concurrent specialist leaves: verify against authoritative scope

When an orchestrator supplies `files_path` and `diff_path`, those artifacts are the authoritative review scope. Concurrent sibling reviewers can make a freshly captured pre-review hash observe a transient checkout state, so do not rely on a bare `git diff | sha256sum` as the only immutability proof.

At completion, compare all three:

1. `HEAD` still equals the supplied head SHA.
2. `git status --short` contains exactly the supplied in-scope state and no new paths.
3. The final scoped tracked diff, produced with `--no-ext-diff --no-textconv`, matches the corresponding tracked sections of the supplied diff artifact byte-for-byte.

If the supplied diff also synthesizes untracked-file patches, compare those separately to their supplied paths; do not expect plain `git diff` to include them. A mismatch is evidence of concurrent mutation: report it rather than editing or reverting another reviewer's work.

### Recover the captured staged artifact after a concurrent checkout replacement

A deployment runner or another process can force-checkout the repository after scope capture, changing `HEAD` and clearing the index while a staged-only review is running. Preserve enough evidence up front to finish the review without restoring or mutating the checkout:

1. Alongside `full.diff` and `files.txt`, capture the staged object IDs for changed paths (`git ls-files -s -- <paths>` or `git diff --cached --raw <base>`).
2. Treat those captured bytes and IDs as authoritative. Do not widen or silently restart against the replacement checkout.
3. For validators that require a real file, materialize the captured staged blob under the run directory: `git cat-file blob <oid> > "$RUN_DIR/<name>"`. Verify it immediately with `git hash-object "$RUN_DIR/<name>"`.
4. Inspect unchanged context from the original base with `git show <original-base>:<path>`, not from the replacement worktree.
5. Run config parsers or isolated validators against the materialized `/tmp` file. This preserves exact staged semantics even when the working-tree path disappeared.
6. Never reset, restage, switch, or restore the checkout. Record the initial/final `HEAD`, status, and staged-diff mismatch in Coverage, and state that the verdict applies to the captured staged artifact rather than the now-current index.

This is a recovery path for review evidence, not permission to ignore ordinary concurrent edits. If the original staged object ID was not captured or cannot be read, mark the review degraded rather than reconstructing the file from memory.

## Exact-artifact-only write budgets

A specialist caller may permit exactly one write: the named persona JSON artifact. In that case, the snapshot-file recipe above is not allowed.

- Capture initial `git rev-parse HEAD`, `git status --short`, and whether the unstaged diff is empty in tool output before review.
- At completion, compare HEAD and status in memory, assert `git diff` is empty when it was initially empty, and compare `git diff --cached --no-ext-diff --no-textconv -U10 <base>` byte-for-byte with the supplied authoritative diff.
- Read the supplied `files.txt` to verify the final staged path list; do not infer scope from status alone.
- Write only the requested artifact, validate it against `references/findings-schema.json`, and return the compact merge-tier JSON without prose.

This keeps strict read-only proof without silently violating the caller's artifact budget by creating helper snapshots.

## Triage an unrelated full-suite failure without worktree mutation

A retry alone is weak evidence. If the failure is outside changed files:

1. Run the failing test/file in isolation on the reviewed checkout.
2. Materialize the base commit under the run directory with `git archive` rather than `git worktree add` (the latter mutates repository metadata).
3. Run the same test against that base snapshot using the existing interpreter.
4. Retry the full suite once only when the isolated evidence indicates a transient/flaky failure.
5. Record the first failure and both retry results in Coverage; do not turn unrelated transient output into a diff finding.

```bash
BASE_DIR="$RUN_DIR/base-snapshot"
mkdir -p "$BASE_DIR"
git -C /absolute/repo archive --format=tar --output="$RUN_DIR/base.tar" "$BASE"
tar -xf "$RUN_DIR/base.tar" -C "$BASE_DIR"
/path/to/.venv/bin/python -m pytest -p no:cacheprovider -q \
  "$BASE_DIR/tests/path/to/failing_test.py"
```

Do not capture the transient failure as a permanent tool limitation. The durable pattern is: isolate, compare against base, retry once, and report the evidence.