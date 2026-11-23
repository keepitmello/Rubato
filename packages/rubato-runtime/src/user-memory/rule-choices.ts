// Settings confirms versions, not a second authored copy of the instructions. Readers join those
// choices to the committed records; an edited record pauses until the person sees the new version.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createNodeGitExec } from "@rubato/memory-core"
import { underWriterLock } from "../dream/runner"
import { parseRecord, type UserRecord } from "./records"
import { userStore, writeJsonFile, type UserStore } from "./store"

type Choices = Record<string, string>
const choicesFile = (store: UserStore) => join(store.paths.runtime, "rule-choices.json")
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const isRulePath = (path: string): boolean =>
  /^(?:constraints|working-style|preferences)\//.test(path) && path.endsWith(".md") &&
  !/[\x00-\x1f]/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")

export async function readRuleChoices(store: UserStore): Promise<Choices> {
  let raw: string
  try { raw = await readFile(choicesFile(store), "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    !Object.entries(parsed).every(([path, blob]) => isRulePath(path) && typeof blob === "string" && objectId.test(blob))) {
    throw new Error("Could not read saved rule choices.")
  }
  return parsed as Choices
}

export function sessionRule(record: UserRecord, choices: Choices) {
  if (!isRulePath(record.path)) return null
  const saved = choices[record.path]
  const state = saved === undefined ? "off" : saved === record.blob && record.description ? "on" : "changed"
  return { description: record.description, blob: record.blob, state } as const
}

/** Run while holding the user store writer lock. A curator can't confirm new wording on anyone's behalf. */
export async function reconcileRuleChoices(store: UserStore, beforePaths: ReadonlySet<string>, afterPaths: ReadonlySet<string>, moves: Readonly<Record<string, string>>): Promise<void> {
  const choices = await readRuleChoices(store)
  let dirty = false
  for (const [path, blob] of Object.entries(choices)) {
    if (afterPaths.has(path)) continue
    const target = moves[path]
    if (target && beforePaths.has(path) && afterPaths.has(target) && isRulePath(target)) choices[target] ??= blob
    delete choices[path]
    dirty = true
  }
  if (dirty) await writeJsonFile(choicesFile(store), choices)
}

/** Pin one tree revision for the whole read. Raw paths are matched as data, never as git expressions. */
async function currentRules(store: UserStore, paths: readonly string[]) {
  const exec = createNodeGitExec()
  const git = (args: string[]) => exec.run(args, { cwd: store.paths.repo, timeoutMs: 10_000 })
  const listed = await git(["--literal-pathspecs", "ls-tree", "-rz", "HEAD", "--", ...paths])
  if (listed.code !== 0) throw new Error("Could not read remembered rules.")
  const records = new Map<string, UserRecord>()
  for (const entry of listed.stdout.split("\0")) {
    const match = /^100(?:644|755) blob ([0-9a-f]+)\t(.+)$/.exec(entry)
    if (!match || !paths.includes(match[2]!)) continue
    const blob = match[1]!, path = match[2]!
    const shown = await git(["cat-file", "blob", blob])
    if (shown.code !== 0) throw new Error("Could not read a remembered rule.")
    records.set(path, parseRecord(path, shown.stdout, blob))
  }
  return records
}

export async function setRuleChoice(memoryRoot: string, path: string, blob: string, load: boolean): Promise<void> {
  if (!isRulePath(path) || !objectId.test(blob)) throw new Error("Invalid rule.")
  const store = userStore(memoryRoot)
  await underWriterLock(store.paths, store.id, "rule choice", async () => {
    const choices = await readRuleChoices(store)
    if (load) {
      const current = (await currentRules(store, [path])).get(path)
      if (!current?.description || current.blob !== blob) throw new Error("This rule changed. Read the current wording before choosing it.")
      choices[path] = blob
    } else delete choices[path]
    await writeJsonFile(choicesFile(store), choices)
  })
}

/** No choices means no git processes, repos or files created during session startup. */
export async function confirmedRuleLines(memoryRoot: string): Promise<string[]> {
  const store = userStore(memoryRoot)
  const choices = await readRuleChoices(store)
  const paths = Object.keys(choices).sort()
  if (!paths.length) return []
  const records = await currentRules(store, paths)
  return paths.flatMap((path) => {
    const record = records.get(path)
    return record && record.blob === choices[path] && record.description ? [record.description] : []
  })
}
