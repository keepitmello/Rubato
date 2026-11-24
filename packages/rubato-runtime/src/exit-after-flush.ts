// A CLI that prints JSON and then calls process.exit() loses whatever the pipe had not taken yet:
// Bun cuts the output at the 64 KB pipe buffer, and the reader sees broken JSON. Let the event loop
// finish the writes by setting the exit code and returning; the timer only ends a process that
// something else keeps open, so a leftover handle cannot hang the caller.
export function exitAfterFlush(code: number, graceMs = 5_000): void {
  process.exitCode = code
  setTimeout(() => process.exit(code), graceMs).unref()
}
