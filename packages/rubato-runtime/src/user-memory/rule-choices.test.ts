import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { confirmedRuleLines, readRuleChoices, reconcileRuleChoices, sessionRule, setRuleChoice } from "./rule-choices"
import { userStore } from "./store"
import { parseRecord } from "./records"

test("choices follow explicitly moved records; only the version a person saw can load", async () => {
  const root = mkdtempSync(join(tmpdir(), "rubato-rule-choices-"))
  try {
    const store = userStore(root), repo = store.paths.repo
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=r", "-c", "user.email=r@r", ...args], { encoding: "utf8" }).trim()
    const path = "preferences/reviews.md", target = "working-style/reviews.md"
    const text = "---\ndescription: Lead code reviews with findings so fixes are easy to find.\n---\n## Evidence\n- Never load this evidence."
    const commit = () => { git("add", "-A"); git("commit", "-qm", "curate") }
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    git("init", "-q")
    writeFileSync(join(repo, path), text)
    commit()
    const blob = git("rev-parse", `HEAD:${path}`)
    expect(await confirmedRuleLines(root)).toEqual([])
    await setRuleChoice(root, path, blob, true)
    expect(await confirmedRuleLines(root)).toEqual(["Lead code reviews with findings so fixes are easy to find."])
    mkdirSync(dirname(join(repo, target)), { recursive: true })
    renameSync(join(repo, path), join(repo, target))
    commit()
    await reconcileRuleChoices(store, new Set([path]), new Set([target]), { [path]: target })
    expect(await readRuleChoices(store)).toEqual({ [target]: blob })
    const edited = text.replace("Lead code reviews", "Begin reviews")
    writeFileSync(join(repo, target), edited)
    commit()
    const changed = git("rev-parse", `HEAD:${target}`)
    expect(sessionRule(parseRecord(target, edited, changed), await readRuleChoices(store))?.state).toBe("changed")
    expect(await confirmedRuleLines(root)).toEqual([])
    await expect(setRuleChoice(root, target, blob, true)).rejects.toThrow("changed")
    await setRuleChoice(root, target, changed, true)
    expect((await confirmedRuleLines(root))[0]).toStartWith("Begin reviews")
    rmSync(join(repo, target))
    commit()
    expect(await confirmedRuleLines(root)).toEqual([])
    await reconcileRuleChoices(store, new Set([target]), new Set(), {})
    expect(await readRuleChoices(store)).toEqual({})
  } finally { rmSync(root, { recursive: true, force: true }) }
})
