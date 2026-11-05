# Terminal feature provenance

The 30 modules directly under `src/` and `src/tools/` are adapted from the
terminal builtin in `code-yeongyu/senpi` tag `v2026.9.4-3`, commit
`b0a446488dafc813ec2ff56e515668c0fa990027`, under the repository MIT license.

The two small host support modules `src/host/shell.ts` and
`src/host/sidecar-store.ts` preserve the corresponding MIT implementations from
the same tag. `src/host-sdk.ts`, `src/host/routing.ts`, and
`src/host/monitor-state-event.ts` are Rubato stock-Pi adapters.

Runtime installation pins
`@code-yeongyu/senpi-pty@2026.9.4-3`, whose published Darwin arm64 prebuild is
byte-identical to both tagged `packages/pty/native/prebuilds/darwin-arm64` and
`crates/senpi-pty/senpi_pty.darwin-arm64.node` (SHA-256
`20f9f1644966694779ee78b76cf60e9f2de2ae0b373a1eb0cf5944afdda0c4da`).
Its screen dependency is `@xterm/headless@6.0.0` (MIT).

Rubato loads its own ABI-compatible Darwin arm64 build directly from this
feature. `native/nonblocking-input.patch` modifies the MIT-licensed crate at
that same pinned commit: writes are admitted to a bounded FIFO and delivered
on a lazy native writer thread, never on the shared JavaScript event loop.
At most 16 queued writes, each at most 1 MiB, are admitted; a full queue or
oversized input returns an explicit failed operation. A successful write means
queued, not that the child has consumed it. Ordering and byte contents are
preserved. Writer errors are retained for later input calls; a child exit may
discard undelivered queued input, as with a closed pipe.
The writer exits on session exit/disconnection. `native/darwin-provenance.json`
records source, patch, lockfile, compiler and binary hashes;
`native/build-darwin.mjs` rebuilds from the immutable upstream commit.
The extra `__rubatoPtyQueuedInput1` marker prevents silently loading the old
blocking build. The existing loader still checks ABI and macOS quarantine.

npm `@code-yeongyu/senpi-pty` 2026.9.4-3 through 2026.9.16-3 ships only that
Darwin arm64 prebuild. Upstream CI (`native-prebuilds.yml`) does produce
`win32-x64` (required) and `win32-arm64` (best-effort). This feature vendors
the win32-x64 artifact from Actions run 35078498005 (head
`a07f94adb3f0f2ccbeab735b939a31f46541a23a`), renamed from
`senpi_pty.win32-x64-msvc.node` to the loader contract name
`senpi_pty.win32-x64.node` (SHA-256
`7e4350f09195b6dd6a919c8924055c14a9c0d765cc8c3dfbfbe7b914be5709b7`).
`crates/senpi-pty/src/lib.rs` at that run is byte-identical to tag
`v2026.9.4-3`; ABI sentinel remains `__senpiPtyAbi1`. The file is copied into
the pinned package's `native/prebuilds/win32-x64/` at session start and never
replaces an already-present host prebuild. npm's Darwin arm64 bytes stay untouched;
Rubato's terminal feature selects its own patched Darwin build instead.
