// Shared seams for the memory slash commands.
//
// Handlers receive the ExtensionCommandContext structurally (only the fields they read) and
// return the rendered text; every user-visible line is ALSO pushed through ctx.ui.notify so
// read-only output never enters model context.

import type { GitExec, MemoryIdentityPaths } from "@rubato/memory-core"

import { MEMORY_UNBOUND_MESSAGE } from "../tool-metadata"

export type NotifyLevel = "info" | "warning" | "error"

export interface MemoryCommandUi {
  notify(message: string, level?: NotifyLevel): void
}

/** Structural slice of ExtensionCommandContext the memory commands read. */
export interface MemoryCommandContext {
  readonly ui?: MemoryCommandUi
  readonly sessionManager?: { getSessionId(): string }
}

export interface MemoryCommandIdentity {
  readonly identity: string
  readonly identityPaths: MemoryIdentityPaths
}

export interface MemoryCommandDeps {
  /** Bound identity for a session; undefined when the folder names no store. */
  contextForSession(sessionId: string): MemoryCommandIdentity | undefined
  exec?: GitExec
}

/** Notify (when a UI is present) and return the same text for headless consumers. */
export function respond(ctx: MemoryCommandContext, text: string, level: NotifyLevel = "info"): string {
  ctx.ui?.notify(text, level)
  return text
}

export function requireIdentity(
  deps: MemoryCommandDeps,
  ctx: MemoryCommandContext,
): MemoryCommandIdentity | string {
  const sessionId = ctx.sessionManager?.getSessionId()
  const identity = sessionId === undefined ? undefined : deps.contextForSession(sessionId)
  return identity ?? MEMORY_UNBOUND_MESSAGE
}
