# Vrata bb plugin

## Development

Before development, fetch `origin`, update the working branch from its upstream,
and synchronize it with current `origin/main` as described in the development
skill's working-tree checklist. Start new branches from current `origin/main`.
Preserve local edits; do not use a reset or force push to synchronize.

Use Node.js 22 and `npm ci`. Read `package.json` for commands and README for
plugin behavior and verification. Run `npm run typecheck`, `npm run build` and
`npm test` before shipping code or build configuration.

Read [.agents/skills/vrata-bb-plugin-dev/SKILL.md](.agents/skills/vrata-bb-plugin-dev/SKILL.md)
for implementation, planning, review, simplification and delivery. It owns the
sequence; this file owns plugin invariants.

## Boundaries

- Keep bb and Plugin SDK APIs compatible with `engines.bb` and
  `engines.bbPluginSdk`. Preserve the provider bridge protocol and capabilities.
- Keep Pi embedded in the plugin; do not require a separately installed agent CLI.
- Store API keys and API URLs locally on the execution host, in the plugin's
  atomic `credentials.json` with `0600` permissions. Do not persist credentials
  in server settings or synchronize them to other hosts. Keep keys out of
  thread history, notifications, logs and git.
- Preserve session cancellation, rejection of late results, atomic session
  persistence and restoration of model and reasoning selections.
- Preserve the configurable API base URL. Model discovery and key validation
  use read-only requests. Use the guide configuration for native Pi retries:
  enabled, maxRetries 20, httpIdleTimeoutMs and provider timeoutMs 3900000,
  provider maxRetries 0. Preserve native compaction and overflow recovery.
  Do not add paid generation to routine verification.
- Use synthetic credentials and loopback HTTP in tests. Keep generated `dist/`,
  dependencies and runtime state out of git.
- Keep model transport in the pinned Pi runtime and use its bundled coding
  tools only for models that support tools. Preserve the existing model and
  reasoning capability contract.

## Versioning

- Treat `package.json` `version` as the single source of truth for the plugin
  version. Keep the root and `packages[""].version` values in `package-lock.json`
  in sync. Never reuse an existing release version or tag.
- A release version bump must update both manifests and any current version
  references in README, then pass the code/build checks above.
- When a release is requested, publish the commit and `v<version>` tag with the
  same version and verify that the remote branch and tag resolve to that commit.

## Delivery

Always finish implementation tasks by committing, pushing a feature branch and
opening or updating its pull request against `main`, without asking for another
confirmation. Do not stop at local changes. Include the PR URL and verification
results in the final response. Never push agent changes directly to `main`.

Review the whole PR diff and run the relevant bb integration checks when
changing provider registration, the manifest, packaging, the bridge protocol or
credential storage. Report which checks actually ran and any platform limitations.
Keep user edits intact and update the existing PR when requested; do not merge
or publish a release without an explicit request.

Save and commit investigation notes, reports and durable findings in
https://github.com/vrata-tg/ai-memory, following that repository's AGENTS.md.
Keep operational development instructions here.

Keep README focused on installation, setup and usage. Update the relevant text
only when those user instructions change; do not append a note for each PR.
Put implementation details, verification results and change history in PR
descriptions and the reports above.
