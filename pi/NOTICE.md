# BB integration attribution

`bridge.ts`, `pi/` and `native-roots.ts` derive from the
[BB Pi provider](https://github.com/get-bb/bb/tree/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/plugins/provider-pi/src),
copied on 2026-10-21. Copyright (c) 2026 Michael Yong.
The original [MIT license](LICENSE) is retained.

The integration is maintained as part of this plugin. It uses one embedded Pi
RPC process per session, direct BB event translation, native model/thinking
commands, and the public Pi SessionManager for checkpoint forks. Model metadata
comes from the shared Vrata guide configuration. Onboarding, credential
redaction, cancellation and BB dynamic-tool calls are integrated here.

The unmodified Pi runtime is sourced separately from pinned npm dependencies;
see [the Pi runtime notice](../packaging/pi/NOTICE.md).
