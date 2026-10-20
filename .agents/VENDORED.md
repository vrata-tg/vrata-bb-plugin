# Vendored development skills

Source: [v-lebedev/vrata-vscode](https://github.com/v-lebedev/vrata-vscode/tree/7fed3ae9b3072031ee20bedcef4f24dfc36df2e0/.agents),
revision `7fed3ae9b3072031ee20bedcef4f24dfc36df2e0`, imported 2026-10-20 from BB project
`proj_xu27pvym86`.

Eight complete general-purpose packages were copied byte-for-byte from
`.agents/skills/`, including references, schemas, scripts and the Compound
Engineering upstream license. The source package records its original
`ai-billing-gateway` provenance in
[its VENDORED.md](https://github.com/v-lebedev/vrata-vscode/blob/7fed3ae9b3072031ee20bedcef4f24dfc36df2e0/.agents/VENDORED.md).

## Local adaptations

- `vrata-bb-plugin-dev/SKILL.md` and its `agents/openai.yaml` are adapted from
  `vrata-vscode-dev`: plugin commands, bb/Plugin SDK compatibility, secret
  settings, runtime configuration permissions and provider bridge checks
  replace VS Code-specific instructions. CI completion applies to configured
  checks; this repository currently has no GitHub Actions workflows.
- Root `AGENTS.md` adapts the source development, delivery and versioning rules
  to this plugin's existing contracts. `.bb/AGENTS.md` directs bb sessions to it.
- `.agents/README.md` and `PROMPTS.md` name the plugin development skill.
  README links to the canonical instructions.
- Root `CLAUDE.md` and `GEMINI.md` retain the source entrypoint content.
- The eight general-purpose packages below are unchanged, including file modes.
  Server operations and the gateway context-index script remain outside this
  package.

## Package verification

Digests are SHA-256 over sorted regular files: relative POSIX path, NUL,
octal permission bits, NUL, file bytes, NUL. Source and destination values
were compared after copying. Credential-pattern scanning found no credentials.
Keep these packages unchanged during normal development; refresh whole packages
and update this record when deliberately importing a new revision.

| Package | Files | Source digest | Destination digest |
| --- | ---: | --- | --- |
| `ce-plan` | 10 | `a6506743408fd4bf27cad9279f8a2c101d7915a8d3565f83d5a29a9bdd078933` | `a6506743408fd4bf27cad9279f8a2c101d7915a8d3565f83d5a29a9bdd078933` |
| `ce-doc-review` | 14 | `75a92a338f06945479321bb061dafd4029666289f2794dc01c7a79b0dc841e72` | `75a92a338f06945479321bb061dafd4029666289f2794dc01c7a79b0dc841e72` |
| `hardening-menu` | 1 | `e3a1bac10fcc37fa6e9bf84df6d3d8b463b720584787b88e98490385f5daf473` | `e3a1bac10fcc37fa6e9bf84df6d3d8b463b720584787b88e98490385f5daf473` |
| `ce-work` | 5 | `383cb61516b9f79d5ff1d15588f29558b9ae5198cb300c35b6cc35be8c95ec6a` | `383cb61516b9f79d5ff1d15588f29558b9ae5198cb300c35b6cc35be8c95ec6a` |
| `ce-simplify-code` | 1 | `97a66ae7153d2a078704ee449467d8759af17d660c44de6f82920e291e62a856` | `97a66ae7153d2a078704ee449467d8759af17d660c44de6f82920e291e62a856` |
| `ce-code-review` | 14 | `e619c84896d6f7affdbf68ae673694c06e221d5fbf7e740e535b8c25d4b0568c` | `e619c84896d6f7affdbf68ae673694c06e221d5fbf7e740e535b8c25d4b0568c` |
| `compound-engineering` | 51 | `bbeb7312ce45be2aa43e000ae7e751938eb9fde2401a25b747cd529b0b80a9cb` | `bbeb7312ce45be2aa43e000ae7e751938eb9fde2401a25b747cd529b0b80a9cb` |
| `github-pr-workflow` | 13 | `1663c5383db5b400a42e7eb15567a51d0e38b6798054290ea6f1b919241a3c74` | `1663c5383db5b400a42e7eb15567a51d0e38b6798054290ea6f1b919241a3c74` |
