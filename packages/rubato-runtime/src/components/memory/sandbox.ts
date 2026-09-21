import { join } from "node:path"

import { resolveAgentHome } from "../agent-home/resolve-agent-home"
import {
  SandboxUnavailableError,
  type SandboxPolicy,
  type SandboxTransform,
} from "./sandbox-contracts"
import { buildPathSandboxTransform } from "./sandbox-platform"

export {
  SandboxUnavailableError,
  type SandboxPolicy,
  type SandboxTransform,
} from "./sandbox-contracts"

export function buildSandboxTransform(input: {
  readonly policy: SandboxPolicy
  readonly worktreeDir: string
  readonly gitCommonDir: string
  readonly payloadPaths: readonly string[]
  readonly runtimeWrites?: readonly string[]
  readonly foreignRoots?: readonly string[]
  readonly command: string
  readonly env: NodeJS.ProcessEnv
  readonly errorRethrow?: (error: SandboxUnavailableError) => never
  readonly platform?: NodeJS.Platform
  readonly which?: (command: string) => string | undefined
}): SandboxTransform {
  return buildPathSandboxTransform({
    surface: "reflection",
    policy: input.policy,
    writableDirs: [
      input.worktreeDir,
      input.gitCommonDir,
      ...(input.runtimeWrites ?? []),
    ],
    payloadPaths: input.payloadPaths,
    fallbackDir: input.worktreeDir,
    foreignRoots: input.foreignRoots,
    command: input.command,
    env: input.env,
    errorRethrow: input.errorRethrow,
    platform: input.platform,
    which: input.which,
  })
}
