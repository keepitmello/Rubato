// Test harness for the memory commands: fake contexts, temp identities, seeded git repos.

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  GitMemoryRepo,
  buildIdentityPaths,
  installHooks,
  type GitExec,
  type GitSeedFile,
} from "@rubato/memory-core"

import type { MemoryFakeExtensionAPI } from "../memory.test-support"
import type {
  MemoryCommandContext,
  MemoryCommandDeps,
  MemoryCommandIdentity,
  MemoryCommandUi,
  NotifyLevel,
} from "./types"

export const TEST_IDENTITY = "test-identity"

export interface FakeCommandUi extends MemoryCommandUi {
  readonly notifications: Array<{ message: string; level: NotifyLevel }>
}

export interface FakeCommandContext extends MemoryCommandContext {
  readonly ui: FakeCommandUi
  readonly sessionId: string
}

export function fakeCommandContext(options: { readonly sessionId?: string } = {}): FakeCommandContext {
  const ui: FakeCommandUi = {
    notifications: [],
    notify(message, level = "info") {
      ui.notifications.push({ message, level })
    },
  }
  const sessionId = options.sessionId ?? "session-1"
  return { ui, sessionId, sessionManager: { getSessionId: () => sessionId } }
}

export async function tempIdentity(root?: string): Promise<{ root: string; identity: MemoryCommandIdentity }> {
  const identityRoot = root ?? (await mkdtemp(join(tmpdir(), "memory-commands-")))
  return {
    root: identityRoot,
    identity: { identity: TEST_IDENTITY, identityPaths: buildIdentityPaths(identityRoot, TEST_IDENTITY) },
  }
}

export async function seededRepo(
  identity: MemoryCommandIdentity,
  seedFiles: readonly GitSeedFile[],
  exec?: GitExec,
): Promise<GitMemoryRepo> {
  const repo = new GitMemoryRepo({
    dir: identity.identityPaths.repo,
    agentId: identity.identity,
    installHooks: (dir: string) => {
      installHooks(dir)
    },
    ...(exec === undefined ? {} : { exec }),
  })
  await repo.init({ seedFiles })
  return repo
}

export function fakeDeps(
  identity: MemoryCommandIdentity | undefined,
  overrides: Partial<MemoryCommandDeps> = {},
): MemoryCommandDeps {
  return { contextForSession: () => identity, ...overrides }
}

export async function invoke(
  pi: MemoryFakeExtensionAPI,
  name: string,
  args: string,
  ctx: FakeCommandContext,
): Promise<string> {
  const registration = pi.commands.find((command) => command.name === name)
  if (registration === undefined) throw new Error(`command not registered: ${name}`)
  const handler = registration.options.handler as (args: string, ctx: MemoryCommandContext) => Promise<string>
  return handler(args, ctx)
}
