# Prometheus metrics semantics and cardinality review

Use this for focused performance reviews of Prometheus exporters, scrape configuration, and Grafana/PromQL dashboards. The goal is production-observable defects, not generic observability advice.

## Minimal review path

1. **Inventory producer and consumer.** Extract the configured metric allowlist and label allowlists, then extract every dashboard expression. Normalize Prometheus client suffixes (`_total`, `_bucket`, `_sum`, `_count`) back to the producer family and verify the sets match. Treat `up` and other Prometheus-native series separately.
2. **Verify the pinned producer implementation.** Against the exact deployed version, confirm each family’s type, emitted suffix, emission path, and label values. Check that the configuration truly disables unlisted families rather than merely filtering labels. Prefer pinned source or image evidence over current docs.
3. **Trace label semantics, not just names.** Confirm dashboard variables and selectors use the same value namespace (`model` vs `model_group` vs deployment name), success and failure paths emit join-compatible labels, and deployment identity is stable across replicas/restarts.
4. **Bound cardinality from reachable values.** Estimate the product of deployment/model/provider/base/status/error dimensions from the actual inventory. Reject customer identifiers, keys, email, IP, user agent, request IDs, free-form error messages, arbitrary URLs, and unbounded requested-model values. A constant empty label is wasteful but not a finding unless it causes a concrete defect.
5. **Check operator/type compatibility.** Counters use `rate`/`increase`; histograms use `histogram_quantile` over `rate(..._bucket[])` aggregated by `le` plus the intended identity; gauges are queried directly.
6. **Check joins and absence behavior.** Ratio numerator and denominator must aggregate to identical label sets. Zero-fill missing numerators from the denominator (`numerator or 0 * denominator`) without manufacturing healthy data when the denominator is absent. Confirm `and`/`or`, `bool`, and outer aggregates preserve the dashboard’s documented no-data semantics.
7. **Check denominator meaning.** Validate the producer’s normalized accounting, especially cache-hit shares and token totals. A syntactically correct ratio is wrong if the denominator excludes the numerator’s quantity.
8. **Verify with the smallest non-mutating probe.** Parse dashboard JSON, compare family sets, and run the project’s existing PromQL/config parser or smoke evidence. Do not start new containers or canaries when pinned-source inspection plus existing runtime evidence already proves the contract.

## Finding threshold

Emit only a measured or code-provable production consequence: missing/empty panels under normal traffic, incorrect ratios/quantiles, conflated deployments, runaway series, or unsupported metric names/types. Route unmeasured scale concerns to residual risk/testing gaps only when they remain useful; otherwise suppress them.

## Script pitfalls

- Do not identify metrics with a broad `litellm_*`/namespace regex: label names such as `litellm_model_name` look like metric names. Match known allowlist members or tokens ending in concrete Prometheus family suffixes, then normalize the suffix.
- The pinned Prometheus image runs as `nobody`. For an isolated `promtool test rules` bind mount, make the temporary parent traversable and inputs readable (`0755` directory, `0644` files). Mount `/tmp` as tmpfs (`--tmpfs /tmp:rw,mode=1777,size=64m`) when host/Docker writable-layer pressure could otherwise turn a semantic test into `no space left on device`; keep all fixtures outside the checkout.