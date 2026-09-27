// Which memory store each folder writes to, for the Memory tab's project list.
// Run with bun: `bun where.ts <dir>...` prints one JSON array. It asks the same
// two functions the engine and the dream CLI ask (the folder's layered config,
// then resolveProjectStore), so the tab never keeps a copy of the rule.
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

import { resolveProjectStore } from "../../../../packages/memory-core/src/index"
import { loadSenpiRubatoConfig } from "../../../../packages/rubato-runtime/src/components/config-resolution/index"

export interface FolderStore {
  readonly dir: string
  /** The store sessions here write to; null when this folder keeps no memory. */
  readonly store: string | null
  /** Why: named in the folder's own config, the git repository, the home directory, or nothing. */
  readonly source: "config" | "git" | "home" | null
  /** `memory.agent` as written in `<dir>/.rubato/rubato.jsonc`, when it names a store. */
  readonly configured: string | null
}

// The config package owns this dependency; resolve it from there, as service.mjs does.
const jsonc = createRequire(join(import.meta.dir, "../../../../packages/rubato-config-core/package.json"))(
  "jsonc-parser",
) as { parse(text: string): unknown }

function ownAgent(dir: string): string | null {
  for (const name of ["rubato.jsonc", "rubato.json"]) {
    const file = join(dir, ".rubato", name)
    if (!existsSync(file)) continue
    // The loader already merged it; this only tells "this folder names it" from "inherited".
    const config = jsonc.parse(readFileSync(file, "utf8")) as { memory?: { agent?: unknown } } | undefined
    const agent = config?.memory?.agent
    return typeof agent === "string" && agent !== "" && agent !== "auto" ? agent : null
  }
  return null
}

export function whereFolder(dir: string, env: Record<string, string | undefined> = process.env): FolderStore {
  if (!existsSync(dir)) return { dir, store: null, source: null, configured: null }
  const agent = loadSenpiRubatoConfig({ cwd: dir, env }).config.memory?.agent
  const resolved = resolveProjectStore(agent, dir, { env })
  const configured = ownAgent(dir)
  if (resolved === undefined) return { dir, store: null, source: null, configured }
  const source = resolved.home ? "home" : agent !== undefined && agent !== "auto" ? "config" : "git"
  return { dir, store: resolved.id, source, configured }
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(process.argv.slice(2).map((dir) => whereFolder(dir)))}\n`)
}
