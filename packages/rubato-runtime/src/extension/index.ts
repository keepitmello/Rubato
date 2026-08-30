import { composeRubatoExtension } from "./compose"
import { createRubatoComponents } from "./component-list"
import { createTaskComponent } from "../components/task"

export const rubatoComponents = createRubatoComponents(createTaskComponent())

export default composeRubatoExtension(rubatoComponents)
export { composeRubatoExtension } from "./compose"
export { createRubatoComponents } from "./component-list"
export { createMemoryComponent } from "../components/memory"
export { loadSenpiRubatoConfig } from "../components/config-resolution"
export type { ComponentContext, ComponentLogger, RubatoComponent, SenpiExtensionAPI } from "./types"
