# Terminal feature provenance

The 30 modules directly under `src/` and `src/tools/` are adapted from the
terminal builtin in `code-yeongyu/senpi` tag `v2026.9.4-3`, commit
`b0a446488dafc813ec2ff56e515668c0fa990027`, under the repository MIT license.

The two small host support modules `src/host/shell.ts` and
`src/host/sidecar-store.ts` preserve the corresponding MIT implementations from
the same tag. `src/host-sdk.ts`, `src/host/routing.ts`, and
`src/host/monitor-state-event.ts` are Rubato stock-Pi adapters.

The native PTY implementation is not copied here. Runtime installation pins
`@code-yeongyu/senpi-pty@2026.9.4-3`, whose published Darwin arm64 prebuild is
byte-identical to both tagged `packages/pty/native/prebuilds/darwin-arm64` and
`crates/senpi-pty/senpi_pty.darwin-arm64.node` (SHA-256
`20f9f1644966694779ee78b76cf60e9f2de2ae0b373a1eb0cf5944afdda0c4da`).
Its screen dependency is `@xterm/headless@6.0.0` (MIT).
