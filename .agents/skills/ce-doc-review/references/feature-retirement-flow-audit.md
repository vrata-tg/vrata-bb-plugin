# Feature-retirement flow audit

Use this checklist when a plan removes a screen, route, command, callback, or other user-visible flow. The goal is to remove only the retired graph while preserving shared roots and safe recovery paths.

## 1. Trace the real graph before judging the plan

Map the complete path from entry point to side effects:

1. visible entry (menu/button/URL/command);
2. serialized action or callback payload;
3. router registration and handler order;
4. FSM/session state transitions;
5. runtime/service wrappers;
6. shared query, formatter, and model primitives;
7. middleware that runs before or after the handler;
8. tests, factual docs, analytics, and later plans that consume the same roots.

A deletion plan is incomplete if it removes only the visible button or if it deletes a shared primitive merely because its name resembles the retired feature.

## 2. Prove the deletion boundary with callers

Classify every candidate symbol:

- **Retired-only:** reachable solely through the removed flow; delete it.
- **Shared:** still used by another live flow; preserve it and add a focused regression.
- **Historical contract:** migrations, append-only analytics values, or past design records; normally preserve unless the task explicitly owns data migration.
- **Dead placeholder:** empty modules, stale exports, comments, source inventories, and label-decoration registries (emoji/icon maps, row-layout sets); delete or update them explicitly so the plan does not leave misleading surface area.

List proven-dead helpers by name in the plan. “Delete unused helpers after checking” leaves too much ambiguity for implementation.

Audit current-state inventories outside the product-doc directory too: README capability lists, architecture/source trees, onboarding examples, and operator docs often name the retired flow. Update factual current-state claims, but preserve historical plans and completion records unless they falsely present themselves as current documentation.

When a removed flow was the last producer of an append-only analytics value, preserve the historical schema/allowlist unless migration is explicitly in scope. Require a positive regression that the historical value still validates or loads; “do not delete it” without naming the owning test file is easy to lose during cleanup.

## 3. Distinguish old-message callbacks from old-format callbacks

These are different cases:

- **Current payload format, removed business target:** the payload can still deserialize successfully, but no domain handler matches; it should reach the final catch-all and usually receives the generic unknown/removed-action response.
- **Unsupported payload version:** parsing returns the project’s stale/version outcome and receives the stale-button response.
- **Malformed or foreign payload:** parsing returns unrecognized and receives the generic fallback.

Do not bump a global callback version for route removal when field layout is unchanged; that invalidates unrelated buttons. Record the no-bump decision explicitly. Test the exact raw/packed payloads rather than inferring behavior from the fallback handler’s name.

Parser behavior is not enough to prove dispatcher behavior. Typed domain filters may match a target while ignoring the version field, so a parser can classify `v=99` as stale even though a surviving domain handler intercepts it first. Probe the real router tree or dispatch a real update. For a narrowly scoped retirement regression, compare the same removed target in both forms—current version should reach the generic removed-target fallback, unsupported version should reach the stale fallback. Do not claim global stale-version handling unless every earlier router is version-gated; changing all those filters is a separate protocol fix, not a hidden part of feature deletion.

For callback platforms, assert acknowledgement/progress completion (`answer`, ACK, etc.) before message editing or other fallible work. If fallback editing is best-effort, scope the requirement accordingly instead of promising an exception-free menu for inaccessible or uneditable messages.

Inspect the fallback's exact observable output, not just its destination state. “Returns to main menu” may mean three different contracts: setting the FSM state, attaching the main-menu keyboard to a generic error message, or rendering the live main-menu text through runtime/database dependencies. If the plan says to reuse the existing fallback but promises the third behavior while the code only does the first two, classify it as a decision or correct the wording; otherwise the implementer must invent a hidden runtime change.

## 4. Include middleware and persisted-state behavior

A removed action may still trigger root middleware before reaching fallback. Check authentication guards, navigation lifecycle hooks, auto-refresh cancellation, rate limits, and logging. Clarify whether those side effects are intentionally preserved.

Deleting a state declaration does not necessarily delete persisted state values. Determine how storage serializes state, whether old values can still be read safely, how users recover (`/start`, surviving buttons, fallback), and whether TTL is sufficient. Add a migration/flush only when the old serialized value is unsafe—not merely because the Python attribute disappeared.

## 5. Audit tests by intent, not by keyword

For every test containing the retired route or feature name, classify it:

- delete behavior tests owned only by the removed flow;
- retarget generic serialization/middleware tests to a surviving route;
- keep the retired target only in explicit old-message fallback regressions;
- adapt shared query/formatter/size/privacy tests so coverage is not lost with the wrapper;
- preserve analytics/migration tests when historical values remain valid.

Cross-check this inventory against the plan’s per-unit file lists, not only its final union of files. If one unit deletes a symbol, every test that imports or calls that symbol must be removed or adapted in that same unit; deferring those tests to a later “surviving regressions” unit makes the intermediate unit unshippable. Either move the test adaptation earlier or merge the units. Also search for UI-label and positional keyboard assertions in sibling acceptance/onboarding tests: removing one button can change row packing and invalidate unrelated `[-1][0]`-style assumptions. Prefer semantic lookup by label, callback payload, or URL.

Also verify sibling consumers of shared roots, including main-menu summaries and background refreshers—not only the most obvious surviving screen.

Avoid blanket “no `usage`/`balance`/`legacy` remains” assertions when those words also describe legitimate domain data. Search for specific route constants, handlers, imports, and wrappers.

## 6. Review future-plan dependencies

When adjacent issues or draft plans modify the same roots, inspect them before approving deletion. Record:

- artifacts the current removal must preserve;
- ownership boundaries for later UI/data changes;
- landing/rebase order;
- tests that should remain until the later plan replaces their consumer.

The smallest correct deletion is the retired graph plus dead wrappers—not the whole semantic domain behind its label.

## 7. Run a focused final blocker gate

When the caller asks for a final blocker/P1-only scan, do not restart a broad multi-persona review or report lower-priority polish. Re-read the complete plan, fetch the live source issue including comments, and inspect only load-bearing code paths that can falsify the plan.

For router-based feature retirement, a useful read-only proof is to simulate the post-removal topology without editing files:

1. Enumerate the real router chain in registration order while skipping the router slated for deletion.
2. Evaluate the actual framework filters for the current-version removed target, the same target with an unsupported version, and at least one surviving target.
3. Require the current removed target to reach the generic final fallback, the unsupported version to reach the stale/version fallback, and the surviving target to keep reaching its domain handler.
4. Direct-call the fallback with mocks to assert observable behavior: callback acknowledgement count, exact text class, main-menu keyboard, FSM destination, and whether runtime/DB dependencies are absent. Do not infer these from handler names.

Also re-run the caller audit for every proposed deletion and check configured persisted-state expiry rather than accepting a plan's TTL claim. Compare repository status before and after; if the target plan was already untracked, say so explicitly and do not imply a Git diff exists.

A compact successful gate should report: verdict, P0/P1 counts, the few load-bearing facts checked, executable probe/test results, files modified (normally none), and unchanged repository status. Suppress P2/FYI material when the caller explicitly limited scope.
