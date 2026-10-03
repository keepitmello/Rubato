#!/usr/bin/env bun
// The check the language migration's runner applies to each file, as a command the model can run
// on its own work before it finishes:  bun verbatim-check.ts <batch.json>
// batch.json: { "memoryDir": "<worktree>", "beforeDir": "<copies of the originals>", "files": ["<path>", …] }

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { translationProblems } from "./verbatim"

export interface MigrationBatch {
  readonly memoryDir: string
  readonly beforeDir: string
  readonly files: readonly string[]
}

/** Problems per file of the batch; a missing file is a problem too. */
export function checkBatch(batch: MigrationBatch): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const file of batch.files) {
    const before = readFileSync(join(batch.beforeDir, file), "utf8")
    let after: string
    try {
      after = readFileSync(join(batch.memoryDir, file), "utf8")
    } catch {
      out.set(file, ["the file is gone; translate it in place, at the same path"])
      continue
    }
    const problems = translationProblems(before, after)
    if (problems.length > 0) out.set(file, problems)
  }
  return out
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined) {
    process.stderr.write("usage: verbatim-check.ts <batch.json>\n")
    process.exit(2)
  }
  const batch = JSON.parse(readFileSync(path, "utf8")) as MigrationBatch
  const problems = checkBatch(batch)
  for (const [file, list] of problems) for (const problem of list) process.stdout.write(`${file}: ${problem}\n`)
  process.stdout.write(problems.size === 0 ? `ok: ${batch.files.length} file(s) pass\n` : `${problems.size} file(s) need fixing\n`)
  process.exit(problems.size === 0 ? 0 : 1)
}
