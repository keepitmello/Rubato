// The moment a session starts closing. The engine runs session_shutdown handlers one extension at a
// time in load order, and earlier extensions tear down first: context-notes, for one, drops the
// session's request gate before the task component's own handler runs. A child that finished in that
// gap woke the lead into a session that could no longer take a turn; the turn was refused, the
// completion counted as delivered, and the lead slept until the user spoke (2026-10-12, a runtime
// update restarted the server while a child was finishing).
//
// The host installs `extension` as its FIRST extension, so `subscribe` listeners run before any
// other extension starts tearing the session down. One signal belongs to one runtime's extension
// list; a reload re-runs the same factories, and each composed instance unsubscribes on its own
// session_shutdown.
export interface SessionClosing {
  readonly extension: (pi: { on(event: "session_shutdown", handler: () => void): void }) => void
  subscribe(listener: () => void): () => void
}

export function createSessionClosing(): SessionClosing {
  const listeners = new Set<() => void>()
  return {
    extension(pi) {
      pi.on("session_shutdown", () => {
        let failure: unknown
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            failure ??= error
          }
        }
        if (failure !== undefined) throw failure
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
