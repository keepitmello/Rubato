import { createAstGrepComponent } from "../components/ast-grep"
import { createLspComponent } from "../components/lsp"
import { createMemoryComponent } from "../components/memory"
import { createScheduleComponent } from "../components/schedule"
import type { RubatoComponent } from "./types"

export function createRubatoComponents(taskComponent: RubatoComponent, options: {
  readonly resolveCwd?: () => string
  /** This session's own environment: a hosted engine runs many sessions in one process. */
  readonly env?: NodeJS.ProcessEnv
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
