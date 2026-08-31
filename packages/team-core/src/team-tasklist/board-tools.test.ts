/// <reference types="bun-types" />

import { expect, test } from "bun:test"

import {
  TEAM_BOARD_TOOL_NAMES,
  TEAM_BOARD_TOOLS,
  TEAM_TASK_CREATE,
  TEAM_TASK_GET,
  TEAM_TASK_LIST,
  TEAM_TASK_UPDATE,
} from "./board-tools"

const AGENT_SESSION_TOOLS = ["Agent", "AgentSend", "AgentOutput", "AgentCancel"] as const
const TEAM_LIFECYCLE_TOOLS = [
  "team_create",
  "team_delete",
  "team_send",
  "team_shutdown_request",
  "team_approve_shutdown",
  "team_reject_shutdown",
] as const
const LEGACY_BOARD_TOOL_NAMES = ["task_create", "task_list", "task_get", "task_update"] as const

test("#given the public board tools #when inspected #then they use team_task_* names only", () => {
  expect(TEAM_BOARD_TOOL_NAMES).toEqual([
    "team_task_create",
    "team_task_list",
    "team_task_get",
    "team_task_update",
  ])
  expect(TEAM_BOARD_TOOLS.map((tool) => tool.name)).toEqual([...TEAM_BOARD_TOOL_NAMES])
  expect([TEAM_TASK_CREATE, TEAM_TASK_LIST, TEAM_TASK_GET, TEAM_TASK_UPDATE]).toEqual([
    ...TEAM_BOARD_TOOL_NAMES,
  ])
})

test("#given the public board tools #when compared with Agent sessions and team lifecycle #then names do not overlap", () => {
  for (const name of TEAM_BOARD_TOOL_NAMES) {
    expect(AGENT_SESSION_TOOLS).not.toContain(name)
    expect(TEAM_LIFECYCLE_TOOLS).not.toContain(name)
    expect(LEGACY_BOARD_TOOL_NAMES).not.toContain(name)
    expect(name.startsWith("team_task_")).toBe(true)
  }
})

test("#given each board tool description #when read #then it distinguishes board work from Agent sessions", () => {
  for (const tool of TEAM_BOARD_TOOLS) {
    expect(tool.description).toMatch(/work-board|board work/i)
    expect(tool.description).toMatch(/Agent/)
    expect(tool.description).not.toMatch(/\btask_output\b/)
    expect(tool.description).not.toMatch(/use the 'task' tool/i)
  }

  expect(TEAM_BOARD_TOOLS[0]?.description).toMatch(/does not start an Agent session/i)
  expect(TEAM_BOARD_TOOLS[1]?.description).toMatch(/AgentOutput/)
  expect(TEAM_BOARD_TOOLS[2]?.description).toMatch(/not an Agent session agentId/)
  expect(TEAM_BOARD_TOOLS[3]?.description).toMatch(/not Agent session lifecycle/)
})
