/**
 * Detached-child only. Do not apply to the parent interactive session.
 * Stock 0.84.2 bash is already child_process.spawn (no pi-pty). Senpi fork PTY
 * needs FORCE_PIPE when there is no controlling TTY. Interactive PTY lives in
 * rubato-terminal-bridge and senpi pi-pty — this helper is not parity for those.
 */
export const STOCK_PIPE_BASH_ENV = "PI_PTY_FORCE_PIPE"
export const SENPI_PIPE_BASH_ENV = "SENPI_PTY_FORCE_PIPE"

export function applyNonInteractiveBashCompat(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...env,
    [SENPI_PIPE_BASH_ENV]: "1",
    [STOCK_PIPE_BASH_ENV]: "1",
  }
}
