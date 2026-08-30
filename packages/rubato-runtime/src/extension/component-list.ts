import { createAstGrepComponent } from "../components/ast-grep"
import { createLspComponent } from "../components/lsp"
import { createMemoryComponent } from "../components/memory"
import type { RubatoComponent } from "./types"

export function createRubatoComponents(taskComponent: RubatoComponent): RubatoComponent[] {
  return [
    createAstGrepComponent(),
    createLspComponent(),
    taskComponent,
    createMemoryComponent(),
  ]
}
