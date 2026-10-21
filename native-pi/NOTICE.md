# Native BB Pi bridge

Source: https://github.com/get-bb/bb/tree/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/plugins/provider-pi/src
Local source checkout: `/workspace/bb`, commit `d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0`, copied 2026-10-21.
Copyright (c) 2026 Michael Yong. MIT license: [LICENSE](LICENSE).
The source fingerprints below also identify the exact local files independently
of the checkout commit. `native-roots.ts` is adapted at the plugin root by the
runtime integration owner; all other listed modules are under this directory.

| Original source path | SHA-256 before adaptation |
| --- | --- |
| `delta-translation.ts` | `e5242d180a1eb0436035db00e7d26f5231d96e51093ff4f334fa7d0aeed7eeff` |
| `model-list.ts` | `e4b44819a64d6f0f05d9f9aa2213e30c2b3d0c070df4512bbaf154d7837156f6` |
| `session-params.ts` | `84ffcf25718960eff677bf81eb32f02ee879e1500517762a075a15b572ab43e9` |
| `visibility.ts` | `d8890f9896311200bdec875037264d496995e408f40bdaf974237ef9be873690` |
| `bridge/bridge.ts` | `1bf1332a5301f03dd0a79b068e901e84b3f00aeb25ad0d2d448328c8306a44ae` |
| `bridge/rpc-session.ts` | `bec6a63fd43102ca38bd96881e79e8f44036369e1a0eb92334203331859f6620` |
| `bridge/rpc-child.ts` | `56227cf500c854bddb8ea9d370a4b7bb39c89da16f52fc384629c9c98719123b` |
| `bridge/catalog.ts` | `0f1405a558049bbf1e8d8a48650000126d627c45ba8ad397fdf1a6a812083e72` |
| `bridge/session-paths.ts` | `c8354412547ab82445f2f40342cbe6576746e2b11a32552dc384d7cb3d11ed8a` |
| `bridge/bb-pi-extension.ts` | `9008adb42c2b7b4717b76d5ef4f3079d47c12a80b4331ede5f1ca01fa7c8af26` |
| `native-roots.ts` | `2838d8575650af52c58fffbb4924173e278c691943f5581989bc3a36388b7ddd` |

## Local adaptations

- Launch the embedded pinned runtime using explicit command/arguments and child
  environment in sessions, catalog and fork helpers. Keep the native RPC, FD
  tool channel, prompt consumption, steer, compaction, events and checkpoints.
- Use plugin sessionDir and native JSONL files. Invoke the root legacy-session
  importer before resume/fork and preserve restored model/thinking selections.
- Scope catalog to `vrata.tg`; retain raw public BB model IDs and route `vrata`.
  Health validates credentials through read-only model discovery. No CLI install
  checks are needed for the embedded artifact.
- Defer construction for key/model onboarding. Acknowledge thread/start and the
  original turn/start before waiting for forms; continue the same native turn
  without resetting its event state or accepting the original input twice.
- Reject late construction results after stop/replacement, cancel pending
  interactions/fork startup, and perform cleanup without exiting the host test
  process. Native session serials still own event filtering and native close
  logic still owns live Pi shutdown.
- Apply a requested thinking level to an existing session through stock RPC
  after restoration: Pi 1.3 CLI --thinking alone does not persist that override.
- Abort live Pi before releasing pending dynamic-tool results, so Stop cannot
  allow a tool-result continuation to issue another model request.
- Complete BB turns and prompt/steer settlement on Pi 1.3 `agent_settled`.
  Low-level `agent_end` retains text/usage and its checkpoint, but cannot finish
  a turn before automatic compaction or overflow recovery completes.
- Pass BB tool exclusions through Pi's native `--exclude-tools` flag. Preserve
  rich failed dynamic-tool results by returning the complete content and setting
  isError via the native tool_result extension hook.
- Redact known credential snapshots from child diagnostics/RPC output while
  preserving native diagnostic text. Malformed/missing credentials never cause
  raw stderr forwarding. Runtime auth/transport redaction is owned by the Vrata
  extension at the plugin root.

- Reuse the pinned Pi thinking-level helper and omit the unused catalog probe API.
- Close the previous Pi child when a cancelled replacement cannot restore it.
