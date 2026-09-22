import { createAstGrepComponent } from "../components/ast-grep"
import { createLspComponent } from "../components/lsp"
import { createMemoryComponent, type MemoryComponentOptions } from "../components/memory"
import type { RubatoComponent } from "./types"

export function createRubatoComponents(taskComponent: RubatoComponent, options: {
  readonly resolveCwd?: () => string
  readonly memoryChildLaunch?: MemoryComponentOptions["childLaunch"]
} = {}): RubatoComponent[] {
  const { memoryChildLaunch, ...shared } = options
  return [
    createAstGrepComponent(shared),
    createLspComponent(shared),
    taskComponent,
    createMemoryComponent({ ...shared, ...(memoryChildLaunch === undefined ? {} : { childLaunch: memoryChildLaunch }) }),
  ]
}
