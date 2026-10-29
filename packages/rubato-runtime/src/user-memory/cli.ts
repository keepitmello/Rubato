#!/usr/bin/env bun
// rubato memory — the shared memory about the user, for Settings > Memory.
//
//   rubato memory view --json        what is remembered: topics, lines, evidence, requests, dream state
//   rubato memory ask <id> --json    handle the request in runtime/asks/<id>/request.json (a model answers
//                                    and changes the memory); the outcome goes to result.json and stdout
//   rubato memory reforget <id> --json  record the forgets of a landed request whose ledger write failed

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { RubatoMemorySettingsSchema } from "@rubato/config-core"
import { resolveMemoryRoot } from "@rubato/memory-core"

import { loadSenpiRubatoConfig } from "../components/config-resolution"
import { childEnv } from "../dream/child-env"
import { dreamLadder } from "../dream/ladder"
import { resolveLaunch } from "../dream/launch"
import { liveMemoryVerdict } from "../dream/live-guard"
import { ASK_ID, recordForgetsAgain, runUserAsk } from "./ask"
import { composeUserView } from "./view"

const here = dirname(fileURLToPath(import.meta.url))

async function main(argv: readonly string[]): Promise<number> {
  const env = process.env
  const [command, id] = argv.filter((arg) => !arg.startsWith("--"))
  const memoryRoot = resolveMemoryRoot(env, homedir())
  if (command === "view") {
    process.stdout.write(`${JSON.stringify(await composeUserView(memoryRoot), null, 2)}\n`)
    return 0
  }
  if (command === "reforget") {
    if (id === undefined || !ASK_ID.test(id)) {
      process.stderr.write("rubato memory: reforget needs a request id\n")
      return 2
    }
    const verdict = liveMemoryVerdict({ env, home: homedir(), cliPath: join(here, "..", "dream", "cli.ts") })
    if (!verdict.allowed) {
      process.stderr.write(`rubato memory: ${verdict.reason}; nothing ran\n`)
      return 2
    }
    process.stdout.write(`${JSON.stringify(await recordForgetsAgain(memoryRoot, id), null, 2)}\n`)
    return 0
  }
  if (command === "ask") {
    if (id === undefined || !ASK_ID.test(id)) {
      process.stderr.write("rubato memory: ask needs a request id\n")
      return 2
    }
    // The same rule as the dream: only the installed Rubato on the default profile writes the default root.
    const verdict = liveMemoryVerdict({ env, home: homedir(), cliPath: join(here, "..", "dream", "cli.ts") })
    if (!verdict.allowed) {
      process.stderr.write(`rubato memory: ${verdict.reason}; nothing ran\n`)
      return 2
    }
    const memory = loadSenpiRubatoConfig({ cwd: homedir(), env }).config.memory ?? RubatoMemorySettingsSchema.parse({})
    const result = await runUserAsk({
      memoryRoot,
      id,
      ladder: dreamLadder(memory.dream.models),
      launch: await resolveLaunch(env),
      systemPrompt: readFileSync(join(here, "user-ask-persona.md"), "utf8"),
      env: childEnv(env),
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.status === "done" ? 0 : 1
  }
  process.stderr.write("usage: rubato memory view --json | rubato memory ask <id> --json | rubato memory reforget <id> --json\n")
  return 2
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`rubato memory: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  },
)
