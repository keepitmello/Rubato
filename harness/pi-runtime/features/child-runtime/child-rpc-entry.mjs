#!/usr/bin/env node
import { APP_NAME } from "../../node_modules/@earendil-works/pi-coding-agent/dist/config.js"
import { configureHttpDispatcher } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js"
import { main } from "../../node_modules/@earendil-works/pi-coding-agent/dist/main.js"

/**
 * Every task child's RPC process: stock rpc-entry plus the lead's working tools
 * (createRubatoChildExtensionFactories), so a subagent or team member works with what the lead
 * works with. An `-e` extension cannot carry them: a team member's in-process subagents need the
 * session's ModelRuntime, which stock hands only to createExtensionFactories. The child profile
 * (providers, notes, guards, role prompt, tier) and a member's bundle still arrive as `-e`.
 */
process.title = `${APP_NAME}-rpc`
process.env.PI_CODING_AGENT = "true"
process.env.AI_AGENT = "pi"
process.emitWarning = () => {}
configureHttpDispatcher()

const member = Boolean(process.env.RUBATO_TASK_MEMBER || process.env.SENPI_TASK_MEMBER)

main(["--mode", "rpc", ...process.argv.slice(2)], {
  createExtensionFactories: async ({ cwd, agentDir, settingsManager, modelRuntime }) => {
    const { createRubatoChildExtensionFactories, createStockTaskRunnerFactories } = await import("../rubato-components/bootstrap.mjs")
    return createRubatoChildExtensionFactories({
      cwd,
      agentDir,
      settingsManager,
      member,
      // A team member's Agent: its subagents run exactly like the lead's.
      ...(member ? {
        createTaskOptions: ({ createTaskRunnerFactories }) => ({
          resolveCwd: () => cwd,
          runnerFactories: createStockTaskRunnerFactories({ agentDir, modelRuntime, createTaskRunnerFactories }),
        }),
      } : {}),
    })
  },
})
