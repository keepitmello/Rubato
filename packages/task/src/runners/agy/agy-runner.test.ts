import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { ManagedRunner, ManagedStartSpec } from "../../manager/types"
import { AGY_AGENT_MODELS, createAgyManagedRunner, isAgyAgentModel, wrapRunnerWithAgy } from "./index"

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeFakeAgy(options: { delayPromptMs?: number } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "rubato-agy-runner-"))
  tempDirs.push(root)
  const home = path.join(root, "home")
  const cwd = path.join(root, "work")
  const logFile = path.join(root, "rpc.jsonl")
  const envFile = path.join(root, "env.json")
  const scriptPath = path.join(root, "fake-agy.mjs")
  const binPath = path.join(root, "agy")

  writeFileSync(
    scriptPath,
    `
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "agents") {
  process.stdout.write("Available agents:\\nrubato-lead\\n");
  process.exit(0);
}

writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  args,
  HOME: process.env.HOME,
  SECRET: process.env.ANTHROPIC_API_KEY ?? null,
}));

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
let pendingPerm = null;
let pendingPromptId = null;
let promptCount = 0;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(msg) + "\\n");

  if (pendingPerm && msg.id === pendingPerm.id && msg.result) {
    const { promptId, text } = pendingPerm;
    pendingPerm = null;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "ok" },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reply(" + text + "): " + msg.result.outcome.optionId } },
      },
    });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }

  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "agy", version: "1.5.14" } } });
  } else if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "sess-1",
        configOptions: [
          { id: "model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon" }] },
          { id: "thought", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high" }] },
        ],
      },
    });
  } else if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    promptCount += 1;
    const text = msg.params.prompt[0].text;
    pendingPromptId = msg.id;
    const delayMs = ${options.delayPromptMs ?? 0};
    if (delayMs > 0) {
      setTimeout(() => {
        if (pendingPromptId !== msg.id) return;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "slow:" + text } } },
        });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }, delayMs);
      return;
    }
    if (promptCount === 1) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "read_file", kind: "read" } },
      });
      pendingPerm = { id: 9001, promptId: msg.id, text };
      send({
        jsonrpc: "2.0",
        id: 9001,
        method: "session/request_permission",
        params: {
          sessionId: "sess-1",
          toolCall: { toolCallId: "tc-1", title: "Read file", kind: "read" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Followup:" + text } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  } else if (msg.method === "session/cancel") {
    if (pendingPromptId !== null) {
      send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "cancelled" } });
      pendingPromptId = null;
    }
  }
});
`,
  )

  writeFileSync(binPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`)
  chmodSync(binPath, 0o755)
  writeFileSync(path.join(root, ".keep"), "")
  const { mkdirSync } = require("node:fs")
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })

  return {
    root,
    home,
    cwd,
    binPath,
    readLogs: () =>
      readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    readEnv: () => JSON.parse(readFileSync(envFile, "utf8")),
  }
}

function makeSpec(cwd: string, overrides: Partial<ManagedStartSpec> = {}): ManagedStartSpec {
  return {
    taskId: "task-agy-1",
    cwd,
    stateDir: path.join(cwd, ".state"),
    depth: 1,
    parentSessionId: "parent-1",
    rootSessionId: "parent-1",
    prompt: "Review this change",
    model: "agy/gemini-4-neon",
    variant: "high",
    ...overrides,
  }
}

describe("createAgyManagedRunner", () => {
  test("drives agy acp with t3-code clientInfo, minimal env, permission auto-allow, tool events, and followUp", async () => {
    const fake = makeFakeAgy()
    const runner = createAgyManagedRunner({
      env: { HOME: fake.home, PATH: process.env.PATH, ANTHROPIC_API_KEY: "must-not-leak" },
      findBinary: () => fake.binPath,
    })

    const handle = await runner.start(makeSpec(fake.cwd))
    const events: string[] = []
    handle.subscribe((event) => events.push(event.type))

    const outcome = await handle.waitForOutcome()
    expect(outcome).toEqual({
      status: "completed",
      finalResponse: "Reply(Review this change): allow-once",
    })
    expect(handle.lastAssistantText()).toBe("Reply(Review this change): allow-once")

    const envInfo = fake.readEnv()
    expect(envInfo.HOME).toBe(fake.home)
    expect(envInfo.SECRET).toBeNull()
    expect(envInfo.args).toEqual(["acp", "--sandbox", "--agent", "rubato-lead"])

    const logs = fake.readLogs()
    const init = logs.find((entry) => entry.method === "initialize")
    expect(init.params.clientInfo).toMatchObject({ name: "t3-code", title: "T3 Code" })
    const configCalls = logs.filter((entry) => entry.method === "session/set_config_option")
    expect(configCalls.map((entry) => [entry.params.configId, entry.params.value])).toEqual([
      ["model", "gemini-4-neon"],
      ["thought", "high"],
    ])
    expect(events).toContain("message_end")

    // Follow-up turn (AgentSend)
    await handle.followUp("Check edge cases")
    const second = await handle.waitForOutcome()
    expect(second).toEqual({
      status: "completed",
      finalResponse: "Followup:Check edge cases",
    })

    await handle.dispose()
  })

  test("enforces single-active-agy concurrency limit and rejects team members", async () => {
    const fake = makeFakeAgy({ delayPromptMs: 120 })
    const runner = createAgyManagedRunner({
      env: { HOME: fake.home, PATH: process.env.PATH },
      findBinary: () => fake.binPath,
      maxConcurrent: 1,
    })

    // Team member spawn is rejected immediately.
    await expect(
      runner.start(makeSpec(fake.cwd, { memberEnv: { RUBATO_TASK_MEMBER: "team::reviewer" } })),
    ).rejects.toThrow(/not team members/i)

    const first = await runner.start(makeSpec(fake.cwd, { taskId: "task-1" }))
    await expect(runner.start(makeSpec(fake.cwd, { taskId: "task-2" }))).rejects.toThrow(/Only 1 agy agent/i)

    await first.abort()
    expect(await first.waitForOutcome()).toEqual({ status: "cancelled" })

    // Slot is released after abort/dispose.
    const next = await runner.start(makeSpec(fake.cwd, { taskId: "task-3" }))
    const outcome = await next.waitForOutcome()
    expect(outcome.status).toBe("completed")
    await next.dispose()
  })

  test("wrapRunnerWithAgy routes only agy/* models to the agy runner", async () => {
    const calls: string[] = []
    const base: ManagedRunner = {
      start: async (spec) => {
        calls.push(`base:${spec.model}`)
        return {} as never
      },
    }
    const agy: ManagedRunner = {
      start: async (spec) => {
        calls.push(`agy:${spec.model}`)
        return {} as never
      },
    }
    const wrapped = wrapRunnerWithAgy(base, agy)
    await wrapped.start(makeSpec("/tmp", { model: "xai/grok-4.7" }))
    await wrapped.start(makeSpec("/tmp", { model: "agy/gemini-4-neon" }))
    expect(calls).toEqual(["base:xai/grok-4.7", "agy:agy/gemini-4-neon"])
    expect(AGY_AGENT_MODELS.every((id) => isAgyAgentModel(id))).toBe(true)
    expect(isAgyAgentModel("google-vertex/gemini-4-argon")).toBe(false)
  })
})
