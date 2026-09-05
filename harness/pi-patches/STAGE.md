# Staging a complete stock Pi 0.84.2 engine

Not an engine switch. Copies a caller-supplied pristine stock install of
`@earendil-works/pi-coding-agent@0.84.2` (package dir or npm install root),
applies the owned patches through `applyPiPatches()`, and publishes a
self-contained package tree with nested provider / TUI / session libraries.

```
node harness/scripts/stage-pi-engine.mjs \
  --stock <pristine stock install or coding-agent@0.84.2> \
  --output <empty dir>
```

Isolated builder hook (does not change the default live plugin build):

```
node harness/scripts/build-engine.mjs --stage-pi \
  --stock <pristine stock install> \
  --output <empty dir>
```

`--stock` is read-only. `--output` must not exist; overlap with the source
tree, Senpi packages in the dependency graph, and absolute or escaping
symlinks fail before publish. On failure this process deletes `--output`
only if it exclusively created that directory. The staged tree must resolve
and run without the stock source (SDK import and `node dist/cli.js --version`).
Do not point `--output` at live `node_modules`, the caller source, or the
default launcher profile.
