/**
 * Codemode / PTY runtime consumers (stock Pi 0.84.2 has no pi-pty and no senpi-codemode).
 *
 * Interactive PTY is NOT the memory-child FORCE_PIPE flag.
 * Stock bash (`dist/core/tools/bash.js`) uses child_process.spawn for both TTY and detached.
 * Senpi fork pi-pty is a native addon with no stock counterpart — do not delete interactive TTY
 * by exporting FORCE_PIPE into the parent session.
 */
export const CODEMODE_PTY_CONSUMERS = [
  {
    id: "stock-bash",
    path: "dist/core/tools/bash.js",
    engine: "stock-0.84.2",
    pty: false,
    note: "child_process.spawn; interactive user_bash in stock TUI uses this backend",
  },
  {
    id: "senpi-pi-pty",
    path: "node_modules/@code-yeongyu/pi-pty or senpi nested",
    engine: "senpi-fork",
    pty: true,
    note: "native PTY; detached children need SENPI_PTY_FORCE_PIPE; no stock package",
  },
  {
    id: "memory-child-launch",
    path: "packages/rubato-runtime/src/components/memory/worker/spawn-payload.ts",
    engine: "detached-child",
    pty: "pipe-override-only",
    note: "applyNonInteractiveBashCompat only on memory child env, never parent interactive session",
  },
  {
    id: "rubato-terminal-bridge",
    path: "packages/rubato-terminal-bridge",
    engine: "rubato-owned",
    pty: true,
    note: "zmx emergency PTY; independent of pi-pty; keep",
  },
  {
    id: "senpi-codemode",
    path: "senpi-codemode/src plus harness/rubato-pi/src/codemode copies",
    engine: "eval-cells",
    pty: false,
    note: "jiti-loaded TS; owned copies are index/eval-notifier/eval-prompt only; remainder still senpi-codemode",
  },
] as const
