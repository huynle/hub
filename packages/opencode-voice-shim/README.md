# @huynle/opencode-voice (renamed)

This package is now **[@huynle/opencode-hub](https://www.npmjs.com/package/@huynle/opencode-hub)**
(source: <https://github.com/huynle/opencode-hub>). This final release, 0.5.0, depends on
`@huynle/opencode-hub` and re-exports its server, TUI and RPC entry points, so an existing install keeps
working and prints a one-line rename notice.

Switch to the new package:

```sh
opencode plugin add @huynle/opencode-hub
```

then remove `@huynle/opencode-voice` from your OpenCode plugins. Your configuration, state, `VOICE_*`
environment variables and the `/voice` command keep working; see
[Migrating from opencode-voice](https://github.com/huynle/opencode-hub#migrating-from-opencode-voice).
