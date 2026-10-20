# Data/query integrity review for read-side plans

Use this checklist when a plan changes account summaries, time-window aggregates, recent-history queries, money rendering, or external quota/spend data. It complements feasibility review; it does not imply a migration or new abstraction.

## 1. Trace the real data contract

Inspect the persisted model, timestamp types, existing indexes, status lifecycle, current aggregate query, all callers of the shared query/renderer, and production transaction/isolation defaults. Do not validate a proposed query from prose alone.

Record explicitly:

- the timestamp column that determines membership (`created_at` vs `finished_at`);
- lower/upper-bound inclusivity;
- owner/key predicates and join ownership;
- which statuses count as actual spend;
- whether future-dated rows are excluded;
- whether naive datetimes have a defined interpretation.

## 2. Conditional aggregate envelope

When one SELECT computes metrics with different horizons, the outer `WHERE` must not silently narrow a metric.

Example: month spend plus rolling-24h activity must scan from the earliest needed lower bound, typically `min(month_start, rolling_start)`, through a shared upper bound. Status and per-metric cutoffs belong inside each conditional aggregate. An outer `status = completed` makes failed/all-status counts wrong; an outer `created_at >= month_start` loses previous-month rows still inside rolling 24h.

Require a first-day-of-month test where rolling 24h crosses the prior calendar month.

## 3. Multi-statement snapshot consistency

Several SELECTs in one SQLAlchemy session are not automatically one coherent snapshot. PostgreSQL `READ COMMITTED` may expose a different committed state to each statement.

If a plan claims a stable account snapshot across wallet, aggregates, and recent rows, require one of:

1. a read-only `REPEATABLE READ` transaction begun before the first SELECT; or
2. one SQL statement/CTE that observes one statement snapshot; or
3. explicit product acceptance of transient mixed-state output (do not call it stable).

For billing/account displays, prefer coherent reads. Verify with a PostgreSQL concurrency test that commits a finalize/refund between statements. SQLite statement-count tests cannot prove this property.

## 4. Spend semantics

A column named `final_cost` is not sufficient evidence that a row was charged. Trace stale settlement and failure paths: non-completed rows may retain nonzero display cost after an unsuccessful settlement.

For user-facing “spent” totals, use the repository’s authoritative charged-state predicate (commonly `status == completed`) or ledger evidence. Apply the same rule to day, month, and lifetime totals unless the plan explicitly documents a different meaning. Add a regression with failed/refunded/transitional rows carrying nonzero cost.

## 5. “All time” still has an upper bound

“All-time history” normally means no lower cutoff, not acceptance of future-corrupted timestamps. Prefer `(-infinity, render_now]` so future rows cannot displace legitimate latest rows. Capture `render_now` once per render and reuse it across related queries/labels.

## 6. Decimal trust boundary

For external quota/spend payloads, `Decimal(str(value))` plus `is_finite()` is necessary but not sufficient. Define behavior for:

- missing/`None` values;
- booleans and malformed strings;
- negative amounts;
- NaN/Infinity;
- huge finite exponents that fail quantization or overflow message length;
- unknown duration enums and malformed reset timestamps.

Catch conversion/quantization exceptions around the full parse-and-format operation. Do not turn provider failure into a believable zero. Do not log or render raw provider values. Keep integer atoms exact and quantize only a temporary presentation value.

## 7. Privacy and query scope

Verify all of the following independently:

- owner predicate on every request aggregate/detail query;
- key predicate for per-key history;
- owner-constrained key-name join;
- owner-scoped key lookup before calling internal render helpers;
- private-chat guard before decrypting/rendering secrets;
- allowlisted failure mapping with neutral unknown fallback;
- HTML escaping/truncation after selecting only customer-safe facts.

A shared renderer is not itself an authorization boundary.

## 8. Index and migration judgment

Separate correctness from performance. Existing `(owner_id, created_at)` indexes often cover bounded account windows but may not efficiently cover all-time per-key latest-N queries. Do not add a speculative migration solely from inspection. Add a production-shaped query-plan/latency gate and a concrete threshold for a follow-up composite index.

## Minimum boundary matrix

- exact calendar start included; one microsecond before excluded;
- exact rolling lower and exact `now` included;
- `now + 1 microsecond` excluded;
- rolling window crossing month/year boundary;
- local calendar label derived from the same localized `now` as SQL cutoffs;
- naive input interpreted per the declared legacy rule;
- equal timestamps resolved by a deterministic secondary key;
- foreign owner, sibling key, and corrupted cross-owner relation excluded.
