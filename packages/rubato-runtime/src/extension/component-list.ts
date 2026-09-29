import { createAstGrepComponent } from "../components/ast-grep"
import { createLspComponent } from "../components/lsp"
import { createMemoryComponent } from "../components/memory"
import { createScheduleComponent } from "../components/schedule"
import type { RubatoComponent } from "./types"

export function createRubatoComponents(taskComponent: RubatoComponent, options: {
  readonly resolveCwd?: () => string
} = {}): RubatoComponent[] {
  const shared = options
  return [
    createAstGrepComponent(shared),
    createLspComponent(shared),
    taskComponent,
    createMemoryComponent(shared),
    createScheduleComponent(shared),
  ]
}
