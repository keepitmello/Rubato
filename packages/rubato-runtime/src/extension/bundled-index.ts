import { createRubatoComponents } from "./component-list"
import { composeRubatoExtension } from "./compose"
import type { RubatoComponent } from "./types"

const lazyTaskComponent: RubatoComponent = {
  name: "task",
  async register(pi, ctx) {
    const taskModule = await import("#rubato-task-runtime")
    await taskModule.createTaskComponent().register(pi, ctx)
  },
}

export const rubatoComponents = createRubatoComponents(lazyTaskComponent)

export default composeRubatoExtension(rubatoComponents)
export { composeRubatoExtension } from "./compose"
export { createRubatoComponents } from "./component-list"
export { createMemoryComponent } from "../components/memory"
export { loadSenpiRubatoConfig } from "../components/config-resolution"
export type { ComponentContext, ComponentLogger, RubatoComponent, SenpiExtensionAPI } from "./types"
