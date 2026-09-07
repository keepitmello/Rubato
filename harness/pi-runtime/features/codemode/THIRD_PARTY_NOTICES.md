# Codemode provenance and notices

This feature preserves source from `@code-yeongyu/senpi-codemode@2026.9.4-3`.

- Upstream repository: `https://github.com/code-yeongyu/senpi.git`
- Upstream directory: `packages/senpi-codemode`
- Package integrity recorded by the source checkout:
  `sha512-DX0Sf6/S5Ez8AeIAzAJyYxrAUAFmDhQ+FP+KxXw+RmLwJfX/cxzktiUcm3v89zR1xHDuiPkCDWQMHGhA5uM1OQ==`
- Copied license SHA-256:
  `b572487f123bf259487f7dab25923af16fecd08ed7a2c50964f393282dba883c`
- License: MIT; the complete text is in `LICENSE` beside this notice.

The complete published runtime `src` tree is retained so worker entrypoints,
Python/Ruby/Julia preludes and runners, the HTTP bridge, renderers, settings, and the
bundled Bun skill do not become hidden dependencies on an installed Senpi package.
The two upstream `AGENTS.md` contributor instruction files are intentionally omitted;
they are neither executable source nor runtime assets.

Rubato's existing modifications to `src/index.ts`, `src/extension/eval-notifier.ts`, and
`src/prompt/eval-prompt.ts` are incorporated. Host imports were redirected to the selected
stock Pi suite and its generic tool executor without dropping the newer upstream
foreground-window, Bun skill/runtime, or monitor-discovery behavior. The local
`stock-host-adapter.ts` restores removed-tool redirects through a stock context hook.
`sanitizeTerminalLabel`, which stock
`pi-tui@0.85.1` does not export, retains the small implementation from
`@code-yeongyu/senpi-tui@2026.9.4-3` under the same MIT notice. No source is loaded at
runtime from the source checkout or from `@code-yeongyu/senpi*` packages.
