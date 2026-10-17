# @huynle/opencode-voice (renamed)

This package is now **[@huynle/hub](https://www.npmjs.com/package/@huynle/hub)**
(source: <https://github.com/huynle/hub>). This release, 0.6.0, depends on `@huynle/hub` and re-exports
its server, TUI and RPC entry points, so an existing install keeps working and prints a one-line rename
notice.

Switch to the new package:

```sh
opencode plugin add @huynle/hub
```

then remove `@huynle/opencode-voice` from your OpenCode plugins. Your configuration, state, `VOICE_*`
environment variables and the `/voice` command keep working; see
[Migrating from opencode-voice or opencode-hub](https://github.com/huynle/hub#migrating-from-opencode-voice-or-opencode-hub).

(The interim name `@huynle/opencode-hub` was never published to npm, so it has no shim.)
