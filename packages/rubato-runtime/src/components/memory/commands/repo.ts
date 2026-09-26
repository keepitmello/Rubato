import { existsSync } from "node:fs"
import { join } from "node:path"

import { GitMemoryRepo, installHooks } from "@rubato/memory-core"

import type { MemoryCommandDeps, MemoryCommandIdentity } from "./types"

/** The store's repository, or the actionable error text when it does not exist yet. */
export function requireExistingRepo(deps: MemoryCommandDeps, identity: MemoryCommandIdentity): GitMemoryRepo | string {
  if (!existsSync(join(identity.identityPaths.repo, ".git"))) {
    return `no memory repository for ${identity.identity} at ${identity.identityPaths.repo} yet; the first memory write creates it`
  }
  return new GitMemoryRepo({
    dir: identity.identityPaths.repo,
    agentId: identity.identity,
    installHooks: (dir: string) => {
      installHooks(dir)
    },
    ...(deps.exec === undefined ? {} : { exec: deps.exec }),
  })
}
