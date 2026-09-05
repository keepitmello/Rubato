# Applying owned Pi 0.84.2 patches

Minimal staging applicator. Not an engine switch.

```
node harness/scripts/apply-pi-patches.mjs \
  --coding-agent <unpacked @earendil-works/pi-coding-agent@0.84.2> \
  --tui <unpacked @earendil-works/pi-tui@0.84.2> \
  --stage <empty scratch dir> \
  --publish <empty output dir>
```

`manifest.json` records package identity, per-file pristine SHA256, ordered
patches (`reload-guard` then `reload-ui` on coding-agent; `unicode-input` on
tui), and postimage SHA256. Apply is `--batch --forward --fuzz=0` with an 8s
timeout. Digest mismatch, identity mismatch, offset/partial patch, or unclean
apply fails the process. No warn-and-continue.

The tool copies listed files into `--stage`, patches there, verifies
postimage, then copies into `--publish`. That last step is a verified copy
into a caller-chosen path, not an atomic rename of a hidden tree. `--stage`
and `--publish` must not already exist, must not overlap each other (including
symlink/realpath aliases), and must not realpath into a source tree. Repeat
against an existing publish dir fails and leaves that tree unchanged. On
failure this process deletes `--publish` only if it exclusively created that
directory; a foreign tree that appears at the path after preflight is left
alone. Source trees are never written.

## Owned modules absent from stock

For a file introduced by a source patch, use `"sha256": null` and an
explicit `"postimageSha256"` in the file entry. Null means the source file
must be absent, including dangling symlinks; it is not a wildcard hash.
The patch must create the file, and its final bytes must match the
postimage before publication. Existing caller files are never adopted or
overwritten. New paths must remain inside their source package.

## Complete tree staging

Overlay publish is not a runnable engine. `harness/scripts/stage-pi-engine.mjs`
copies the full stock package and nested dependencies, then overlays the
verified patch publish. See `STAGE.md`. Isolated builder hook only:

```
node harness/scripts/build-engine.mjs --stage-pi --stock <install> --output <empty dir>
```

Default `build-engine.mjs` still mirrors the Rubato plugin and links Senpi-nested
deps. Do not point `--output` at live `node_modules` or the caller source.

## Remaining cutover gaps

RPC `check_reload_veto` protocol, senpi-only TUI extras, launcher / live
profile / `cli.js` boot, swapping the running harness onto published trees,
Rubato extensions still built against Senpi.
