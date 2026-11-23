import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { MemoryIdentityPaths } from "@rubato/memory-core"
import type { Git } from "./runner"

/** Recall only determines eligibility for a spot check. Neither the model nor search receives counts. */
export function coldCandidates(pathsByAge: string[], recalled: ReadonlySet<string>, seed: string): string[] {
  const draw = (pool: string[], count: number) => pool.map(path => ({
    path, order: createHash("sha256").update(`${seed}\0${path}`).digest("hex"),
  })).sort((a, b) => a.order.localeCompare(b.order)).slice(0, count).map(entry => entry.path)
  const old = draw(pathsByAge.slice(0, Math.max(2, Math.ceil(pathsByAge.length / 3))), 2)
  return [...old, ...draw(pathsByAge.filter(path => !old.includes(path) && !recalled.has(path)), 2)]
}

export async function consolidationGuide(input: {
  git: Git; paths: MemoryIdentityPaths; worktree: string; store: string; seed: string; runDir: string; env: NodeJS.ProcessEnv
}): Promise<string> {
  const { git, worktree, paths, store, seed, env } = input
  // Only committed markdown blobs in the checked-out revision: no symlinks, runtime, or system prompts.
  const tree = await git(worktree, ["ls-tree", "-rz", "HEAD"])
  const files = tree.stdout.split("\0").flatMap(row => {
    const match = /^100(?:644|755) blob [0-9a-f]+\t(.+\.md)$/.exec(row)
    return match && !/^(?:system|scratch)\//.test(match[1]!) ? [match[1]!] : []
  })
  const ages = new Map<string, number>()
  let at = 0
  for (const line of (await git(worktree, ["log", "--format=@%ct", "--name-only", "--no-renames", "--", "*.md"])).stdout.split("\n")) {
    if (/^@\d+$/.test(line)) at = Number(line.slice(1))
    else if (line && !ages.has(line)) ages.set(line, at)
  }
  const recalled = new Set<string>()
  const agents = dirname(paths.root)
  const logDir = env.MSEARCH_STATE_DIR || env.ROO_STATE_DIR || join(dirname(agents), "msearch-state")
  const log = await readFile(join(logDir, "recall-log.jsonl"), "utf8").catch(() => "")
  const prefix = `${store}/repo/`
  for (const row of log.split("\n")) {
    try {
      for (const hit of JSON.parse(row).hits) if (typeof hit.rel_path === "string" && hit.rel_path.startsWith(prefix)) recalled.add(hit.rel_path.slice(prefix.length))
    } catch { /* older or partial log row */ }
  }
  const review = coldCandidates([...files].sort((a, b) => (ages.get(a) ?? 0) - (ages.get(b) ?? 0)), recalled, seed)
  const here = dirname(fileURLToPath(import.meta.url))
  const msearch = join(here, "../../../../harness/msearch")
  const py = env.MSEARCH_PYTHON || join(msearch, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
  let neighbors: Record<string, string[]> = {}
  if (files.length > 1 && existsSync(py)) {
    const result = spawnSync(py, [join(here, "record-neighbors.py"), msearch, paths.repo], {
      cwd: worktree, env, input: JSON.stringify(files), timeout: 15_000, encoding: "utf8", maxBuffer: 8_000_000,
    })
    if (result.status === 0) neighbors = JSON.parse(result.stdout)
  }
  const file = join(input.runDir, "consolidation.md")
  await writeFile(file, [
    "# Review these records (a sample, not a verdict)", ...review.map(path => `- ${path}`),
    "", "# Closest existing records (cached msearch vectors)",
    "Look up a candidate home by path. For missing or new records, search the worktree's descriptions and conclusions for the question instead.",
    ...Object.entries(neighbors).map(([path, near]) => `${path}\t${near.join("\t")}`), "",
  ].join("\n"))
  return file
}
