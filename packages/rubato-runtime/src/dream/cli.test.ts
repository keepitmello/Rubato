import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { dreamLadder } from "./ladder"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dreamStatus(userConfig: string | undefined): unknown {
  const home = mkdtempSync(join(tmpdir(), "dream-cli-test-"))
  dirs.push(home)
  mkdirSync(join(home, ".rubato", "memory"), { recursive: true })
  if (userConfig !== undefined) writeFileSync(join(home, ".rubato", "rubato.jsonc"), userConfig)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    RUBATO_MEMORY_HOME: join(home, ".rubato", "memory"),
    RUBATO_PI_CODING_AGENT_DIR: join(home, "agent"),
  }
  const out = execFileSync(process.execPath, [join(import.meta.dir, "cli.ts"), "--json"], { cwd: home, env, encoding: "utf8" })
  return JSON.parse(out)
}

describe("rubato dream --json status", () => {
  test("#given no dream models in the config #when status is read #then the default ladder is reported as models", () => {
    expect(dreamStatus(undefined)).toEqual({
      models: [
        { model: "b-ai/deepseek-v4.1-flash", thinking: "medium" },
        { model: "xai/grok-4.7", thinking: "medium" },
        { model: "anthropic/claude-haiku-4-5", thinking: "off" },
      ],
      stores: [],
    })
  })

  test("#given memory.dream.models in the user config #when status is read #then that ladder is reported in order", () => {
    const config = JSON.stringify({ memory: { dream: { models: ["xai/grok-4.7", { model: "anthropic/claude-haiku-4-5", reasoning: "off" }] } } })
    expect(dreamStatus(config)).toEqual({
      models: [{ model: "xai/grok-4.7" }, { model: "anthropic/claude-haiku-4-5", thinking: "off" }],
      stores: [],
    })
  })
})

describe("dreamLadder", () => {
  test("#given bare ids, pairs, repeats and a name without a provider #when laddered #then order holds and only launchable, first-seen rungs stay", () => {
    expect(dreamLadder([
      "b-ai/deepseek-v4.1-flash",
      { model: "xai/grok-4.7", reasoning: "high" },
      "grok",
      { model: "b-ai/deepseek-v4.1-flash", reasoning: "low" },
    ])).toEqual([
      { model: "b-ai/deepseek-v4.1-flash" },
      { model: "xai/grok-4.7", thinking: "high" },
    ])
  })
})
