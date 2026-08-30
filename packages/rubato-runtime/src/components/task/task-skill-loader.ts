import { homedir } from "node:os"

import { createFsSkillLoader, type SkillLoader } from "@rubato/senpi-task"

import { resolveAgentHome } from "../agent-home/resolve-agent-home"

export interface TaskSkillLoaderOptions {
  readonly agentDir?: string
  readonly homeDir?: string
}

export function createTaskSkillLoader(options: TaskSkillLoaderOptions = {}): SkillLoader {
  const homeDir = options.homeDir ?? homedir()
  const agentDir = options.agentDir ?? resolveAgentHome({ env: process.env, homeDir })
  return createFsSkillLoader({ homeDir, agentDir })
}
