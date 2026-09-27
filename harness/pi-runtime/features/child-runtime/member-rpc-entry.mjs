#!/usr/bin/env node
import { fileURLToPath } from "node:url"

import { APP_NAME } from "../../node_modules/@earendil-works/pi-coding-agent/dist/config.js"
import { configureHttpDispatcher } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js"
import { main } from "../../node_modules/@earendil-works/pi-coding-agent/dist/main.js"
import { createStockTaskRunnerFactories } from "./stock-rpc-runtime.mjs"

/**
 * A team member's RPC process: stock rpc-entry plus the task component, so the member has the
 * Agent/AgentSend/AgentCancel its prompt promises. An `-e` extension cannot do this: in-process
 * subagents need the session's ModelRuntime, which stock hands only to createExtensionFactories.
 * The child profile and the member bundle still arrive as `-e`, exactly as for any child.
 */
const root = fileURLToPath(new URL("../..", import.meta.url))

process.title = `${APP_NAME}-rpc`
process.env.PI_CODING_AGENT = "true"
process.env.AI_AGENT = "pi"
process.emitWarning = () => {}
configureHttpDispatcher()

main(["--mode", "rpc", ...process.argv.slice(2)], {
  createExtensionFactories: async ({ cwd, agentDir, modelRuntime }) => {
    const [{ createRubatoTaskExtension }, { createAgentSession, DefaultResourceLoader }] = await Promise.all([
      import("../rubato-components/extensions/rubato.js"),
      import("../../node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    ])
    const factory = createRubatoTaskExtension({
      resolveCwd: () => cwd,
      createTaskOptions: ({ createTaskRunnerFactories }) => ({
        resolveCwd: () => cwd,
        runnerFactories: createStockTaskRunnerFactories({
          root,
          agentDir,
          modelRuntime,
          createTaskRunnerFactories,
          createAgentSession,
          DefaultResourceLoader,
        }),
      }),
    })
    return [{ name: "rubato-task", factory }]
  },
})
