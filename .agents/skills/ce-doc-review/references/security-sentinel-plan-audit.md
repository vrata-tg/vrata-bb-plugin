# Security-sentinel plan audit

Use this when reviewing a plan that expands a privacy-sensitive UI, account history, key/credential display, billing facts, or data sourced from an external service. The goal is to find **planning gaps**, not code defects already covered by the plan.

## Trace the real trust boundaries

Read the plan first, then inspect the current production paths end to end:

1. **Entry authorization** — router/middleware guards, private-vs-group behavior, callback and FSM identifiers.
2. **Resource ownership** — owner-scoped lookup before renderer/decrypt/external calls; query predicates for owner + resource; corrupted cross-owner joins.
3. **Safe view boundary** — fields copied from persistence into the display view; forbidden source fields that must never enter it.
4. **External payload** — envelope validation, field types, numeric/date parsing, boundedness, and safe degradation.
5. **Final rendering** — every dynamic field, wrapper/prefix added after the shared renderer, HTML validity, and the actual final delivery limit.
6. **Logging** — malformed values and raw upstream bodies must not reappear through exception strings, `exc_info`, or diagnostic context.

Inspect existing tests too: a plan may say “preserve privacy tests” while the current tests only call a guard/helper directly and never exercise the real router/handler path.

## Evidence-driven attack cases

### Authorization and IDOR

- Group/non-private event through the real dispatcher must stop before session creation, decrypt, mutation, external API calls, and rendering.
- Foreign callback IDs and stale/foreign FSM IDs must produce the same not-found result as nonexistent IDs.
- Assert sensitive downstream calls were not made; a query returning no rows is weaker proof than proving decrypt/renderer/external calls were unreachable.
- Background jobs bypass request middleware. Verify how owner identity becomes the delivery chat and how recovery reconstructs that target.

### Negative privacy canaries

Build one object/row containing a distinct canary in every forbidden source field, including nested JSON/snapshots and legacy/unused columns. Assert canaries are absent from:

- the safe view/dataclass;
- account rendering;
- per-resource rendering;
- logs.

Prefer a field allowlist plus a forbidden-field regression over one test per secret. Include fields that currently have no producer (legacy/corrupt data still exists) and arbitrary attributes representing future prompt/response/provider-body additions.

### Error reason taxonomy

Trace every producer of persisted error codes. Plans that say “known codes” must list the exact producer taxonomy and distinguish:

- terminal failure reasons;
- non-failure billing/status markers;
- empty/unknown/legacy values.

The display layer maps exact allowlisted codes to fixed copy. Unknown, very long, HTML-like, newline/control-character, or unused secondary error fields must all collapse to one neutral fallback. Raw values must not appear in UI or logs.

### Escaping is not normalization

HTML escaping blocks tags but does not block line/layout spoofing, control characters, credential-bearing URLs, or unbounded output. For every dynamic field classify whether it must be:

- escaped;
- single-line normalized;
- length-bounded;
- structurally validated (for example public URLs without userinfo/query secrets);
- rejected or replaced rather than truncated (copy-sensitive credentials).

Test `<>&`, CR/LF, C0 controls, overlong values, and credential-bearing URL forms. Truncate raw text **before** escaping so an entity is never cut in half.

### Malformed numeric payloads

“Parse with `Decimal` and require finite” is insufficient. Finite values can still have hostile exponents or formatted lengths and can fail quantization. Require the domain contract as well: sign, finite status, exponent/magnitude or output-length bound, and a deterministic unavailable state.

Minimum cases: malformed type, bool/container, NaN, Infinity, negative, huge digit string, huge finite exponent, and mixed valid/invalid fields. Verify the rest of the screen survives and no raw payload is logged.

### Final-message limits

Measure the fully assembled production payload, not only a row or base renderer. Include:

- action notices prepended/appended after rendering;
- active/revoked/new variants;
- full credential and URL fields;
- entity-expanding text;
- all required rows.

Define field and row budgets plus deterministic degradation order. Reuse existing caps/helpers. Validate fixed HTML structure and a conservative final length; do not rely only on bare `len()` of one intermediate fragment.

## Finding threshold

Report only gaps that require a plan change. For each finding include:

- severity;
- direct plan quote or missing test contract;
- repository evidence with file/line;
- the smallest precise plan/test change that closes it.

Do not re-report protections already specified and adequately tested. Keep implementation proposals minimal: reuse the current guard, owner lookup, formatter caps, stdlib parsing, and existing safe logging pattern before proposing new abstractions or dependencies.
