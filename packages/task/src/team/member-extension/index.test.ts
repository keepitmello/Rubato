import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { TeamModeConfigSchema } from "@rubato/team-core/config"
import { sendMessage } from "@rubato/team-core/team-mailbox"
import { getInboxDir } from "@rubato/team-core/team-registry"

import { TEAM_BOARD_TOOL_NAMES } from "@rubato/team-core/team-tasklist"
import { writeMemberTaskMap } from "../member-map"
import { resolveTeamRuntimeDirs } from "../storage"

import registerMemberExtension, { createMemberBoardService, parseMemberExtensionEnv } from "./index"
import { TEAM_MESSAGE_CUSTOM_TYPE } from "../messaging/message"

const TEAM_RUN_ID = "77777777-7777-4777-8777-777777777777"
const MESSAGE_ID = "88888888-8888-4888-8888-888888888888"
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("member extension lifecycle", () => {
  test("#given unread mail during extension loading #when session_start fires #then inbound team mail steers at the lifecycle edge", async () => {
    const root = mkdtempSync(join(tmpdir(), "senpi-member-extension-"))
    roots.push(root)
    const stateDir = join(root, "state")
    const sessionDir = join(root, "sessions")
    const config = TeamModeConfigSchema.parse({ base_dir: join(stateDir, "teams") })
    mkdirSync(sessionDir, { recursive: true })
    await sendMessage({
      version: 1,
      messageId: MESSAGE_ID,
      from: "lead",
      to: "alice",
      kind: "message",
      body: "start only after bind",
      timestamp: 1,
    }, TEAM_RUN_ID, config, { isLead: true, activeMembers: ["alice"] })
    await writeMemberTaskMap(
      resolveTeamRuntimeDirs({ project_dir: root, task: { state_dir: stateDir } }, TEAM_RUN_ID).runtimeDir,
      { alice: "st_00000001" },
    )

    const handlers = new Map<string, Array<() => unknown | Promise<unknown>>>()
    const toolNames: string[] = []
    const exposures: Array<string | undefined> = []
    const injected: Array<{ message: Record<string, unknown>; options: Record<string, unknown> | undefined }> = []
    const visible: string[] = []
    let loading = true
    const api = {
      on(event: string, handler: () => unknown | Promise<unknown>) {
        const registered = handlers.get(event) ?? []
        registered.push(handler)
        handlers.set(event, registered)
      },
      registerTool(tool: { name: string; exposure?: string }) {
        toolNames.push(tool.name)
        exposures.push(tool.exposure)
      },
      sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
        if (loading) throw new Error("runtime action called during extension loading")
        injected.push({ message, options })
      },
      sendUserMessage(content: string) {
        if (loading) throw new Error("runtime action called during extension loading")
        visible.push(content)
      },
    } as unknown as ExtensionAPI
    const previous = captureMemberEnv()
    Object.assign(process.env, {
      SENPI_TASK_MEMBER: `${TEAM_RUN_ID}::alice`,
      RUBATO_TASK_MEMBER_TASK_ID: "st_00000001",
      RUBATO_TASK_TEAM_CONFIG: JSON.stringify({
        ...config,
        stateDir,
        members: ["alice"],
      }),
      SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
    })

    try {
      await registerMemberExtension(api)
      expect(injected).toEqual([])
      expect(toolNames).toEqual(["team_send", ...TEAM_BOARD_TOOL_NAMES])
      // Undeclared extension tools start behind tool_search; every member tool must be live at once.
      expect(exposures.every((exposure) => exposure === "direct")).toBe(true)

      loading = false
      await dispatch(handlers, "session_start")

      expect(injected).toHaveLength(1)
      expect(injected[0]).toEqual({
        message: {
          customType: "senpi-task:team-message",
          content: expect.stringContaining("<peer_message from=\"lead\">"),
          display: false,
          details: { messageId: MESSAGE_ID },
        },
        options: { triggerTurn: true, deliverAs: "steer" },
      })
      expect(String(injected[0]?.message.content)).not.toContain(MESSAGE_ID)
      expect(visible).toEqual([])
    } finally {
      await dispatch(handlers, "session_shutdown")
      restoreMemberEnv(previous)
    }
  })

  test.each(["artifact", "board"] as const)("#given a %s-only update #when the member settles without team_send #then it stays quiet until real peer work arrives", async (surface) => {
    const root = mkdtempSync(join(tmpdir(), "senpi-member-quiet-"))
    roots.push(root)
    const stateDir = join(root, "state")
    const sessionDir = join(root, "sessions")
    const config = TeamModeConfigSchema.parse({ base_dir: join(stateDir, "teams") })
    mkdirSync(sessionDir, { recursive: true })
    const { runtimeDir } = resolveTeamRuntimeDirs({ project_dir: root, task: { state_dir: stateDir } }, TEAM_RUN_ID)
    mkdirSync(runtimeDir, { recursive: true })
    await writeMemberTaskMap(
      runtimeDir,
      { alice: "st_00000001" },
    )

    const handlers = new Map<string, Array<() => unknown | Promise<unknown>>>()
    const injected: Array<{ message: Record<string, unknown>; options: Record<string, unknown> | undefined }> = []
    let loading = true
    const api = {
      on(event: string, handler: () => unknown | Promise<unknown>) {
        const registered = handlers.get(event) ?? []
        registered.push(handler)
        handlers.set(event, registered)
      },
      registerTool() {},
      sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
        if (loading) throw new Error("runtime action called during extension loading")
        injected.push({ message, options })
      },
      sendUserMessage() {
        if (loading) throw new Error("runtime action called during extension loading")
      },
    } as unknown as ExtensionAPI
    const previous = captureMemberEnv()
    Object.assign(process.env, {
      SENPI_TASK_MEMBER: `${TEAM_RUN_ID}::alice`,
      RUBATO_TASK_MEMBER_TASK_ID: "st_00000001",
      RUBATO_TASK_TEAM_CONFIG: JSON.stringify({
        ...config,
        stateDir,
        members: ["alice"],
      }),
      SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
    })

    try {
      await registerMemberExtension(api)
      loading = false
      await dispatch(handlers, "session_start")
      await dispatch(handlers, "agent_start")
      if (surface === "artifact") {
        writeFileSync(join(root, "result.md"), "Existing evidence incorporated; no new peer action.\n")
      } else {
        const board = createMemberBoardService(parseMemberExtensionEnv(process.env))
        const task = await board.createTask(TEAM_RUN_ID, {
          subject: "Retain checked evidence",
          description: "No new peer action.",
          status: "pending",
        })
        for (const status of ["claimed", "in_progress", "completed"] as const) {
          await board.updateTask({ teamRunId: TEAM_RUN_ID, taskId: task.id, status })
        }
        expect((await board.getTask(TEAM_RUN_ID, task.id)).status).toBe("completed")
      }
      await dispatch(handlers, "agent_settled")
      await dispatch(handlers, "agent_start")
      await dispatch(handlers, "agent_settled")
      expect(injected).toEqual([])

      // Quiet completion must not disable real peer handoffs or critical corrections.
      await sendMessage({
        version: 1,
        messageId: MESSAGE_ID,
        from: "bob",
        to: "alice",
        kind: "message",
        body: "The retained snapshot is mutable; repair it before relying on that verdict.",
        timestamp: 1,
      }, TEAM_RUN_ID, config, { isLead: false, activeMembers: ["alice", "bob"] })
      const deadline = Date.now() + 5_000
      while (injected.length === 0 && Date.now() < deadline) await Bun.sleep(25)
      expect(injected).toHaveLength(1)
      expect(injected[0]?.message.customType).toBe(TEAM_MESSAGE_CUSTOM_TYPE)
      expect(injected[0]?.message.content).toContain("snapshot is mutable")
      expect(injected[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" })

      // Receiving information alone does not create an acknowledgement obligation.
      await dispatch(handlers, "agent_start")
      await dispatch(handlers, "agent_settled")
      expect(injected).toHaveLength(1)
    } finally {
      await dispatch(handlers, "session_shutdown")
      restoreMemberEnv(previous)
    }
  })
  test("#given the first poll fails at session_start #when the cause clears #then later team mail still arrives", async () => {
    const root = mkdtempSync(join(tmpdir(), "senpi-member-start-failure-"))
    roots.push(root)
    const stateDir = join(root, "state")
    const sessionDir = join(root, "sessions")
    const config = TeamModeConfigSchema.parse({ base_dir: join(stateDir, "teams") })
    mkdirSync(sessionDir, { recursive: true })
    const { runtimeDir } = resolveTeamRuntimeDirs({ project_dir: root, task: { state_dir: stateDir } }, TEAM_RUN_ID)
    mkdirSync(runtimeDir, { recursive: true })
    await writeMemberTaskMap(runtimeDir, { alice: "st_00000001" })
    // A reservation torn by a crash makes every poll throw until it is gone.
    const inbox = getInboxDir(config.base_dir ?? "", TEAM_RUN_ID, "alice")
    mkdirSync(inbox, { recursive: true })
    const torn = join(inbox, ".delivering-torn.json")
    writeFileSync(torn, "")

    const handlers = new Map<string, Array<() => unknown | Promise<unknown>>>()
    const injected: Array<Record<string, unknown>> = []
    const api = {
      on(event: string, handler: () => unknown | Promise<unknown>) {
        const registered = handlers.get(event) ?? []
        registered.push(handler)
        handlers.set(event, registered)
      },
      registerTool() {},
      sendMessage(message: Record<string, unknown>) {
        injected.push(message)
      },
      sendUserMessage() {},
    } as unknown as ExtensionAPI
    const previous = captureMemberEnv()
    Object.assign(process.env, {
      SENPI_TASK_MEMBER: `${TEAM_RUN_ID}::alice`,
      RUBATO_TASK_MEMBER_TASK_ID: "st_00000001",
      RUBATO_TASK_TEAM_CONFIG: JSON.stringify({ ...config, stateDir, members: ["alice"] }),
      SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
    })

    try {
      await registerMemberExtension(api)
      await dispatch(handlers, "session_start")
      expect(injected).toEqual([])

      rmSync(torn)
      await sendMessage({
        version: 1,
        messageId: MESSAGE_ID,
        from: "lead",
        to: "alice",
        kind: "message",
        body: "after the crash",
        timestamp: 1,
      }, TEAM_RUN_ID, config, { isLead: true, activeMembers: ["alice"] })

      const deadline = Date.now() + 5_000
      while (injected.length === 0 && Date.now() < deadline) await Bun.sleep(50)
      expect(injected).toHaveLength(1)
      expect(injected[0]?.details).toEqual({ messageId: MESSAGE_ID })
    } finally {
      await dispatch(handlers, "session_shutdown")
      restoreMemberEnv(previous)
    }
  })
})

const MEMBER_ENV_NAMES = [
  "SENPI_TASK_MEMBER",
  "RUBATO_TASK_MEMBER_TASK_ID",
  "RUBATO_TASK_TEAM_CONFIG",
  "PI_CODING_AGENT_SESSION_DIR",
] as const

type MemberEnvName = typeof MEMBER_ENV_NAMES[number]
type MemberEnvSnapshot = Readonly<Partial<Record<MemberEnvName, string>>>

function captureMemberEnv(): MemberEnvSnapshot {
  return Object.fromEntries(
    MEMBER_ENV_NAMES.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
  )
}

function restoreMemberEnv(snapshot: MemberEnvSnapshot): void {
  for (const name of MEMBER_ENV_NAMES) {
    const value = snapshot[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

async function dispatch(
  handlers: ReadonlyMap<string, readonly (() => unknown | Promise<unknown>)[]>,
  event: string,
): Promise<void> {
  for (const handler of handlers.get(event) ?? []) await handler()
}
