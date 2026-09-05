# ui-slash-remote.patch — builtin slash `remoteMode`

Adds `remoteMode` on stock `dist/core/slash-commands.js` `BUILTIN_SLASH_COMMANDS`
so InteractiveMode `listInteractiveCommands()` / `submitInput` can reject
`terminal-only` and `native-action` commands for remote control.

Does not add Senpi-only commands (`favorite-models`, `/exit`). Stock `changelog`
gets `terminal-only`.

## Apply order

After `reload-ui`. Does not overlap `ui-interactive` (different file).
Session-control does not touch this file.

```
patch -p1 --fuzz=0 --batch --forward -i ui-slash-remote.patch
```
