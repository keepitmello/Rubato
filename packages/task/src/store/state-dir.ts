import { existsSync } from "node:fs"
import { join } from "node:path"

import type { StateDirConfig } from "./types"

export function resolveStateDir(config: StateDirConfig): string {
  if (config.task?.state_dir) return config.task.state_dir
  const next = join(config.project_dir, ".rubato", "task")
  const legacy = join(config.project_dir, ".rubato", "senpi-task")
  if (existsSync(legacy) && !existsSync(next)) return legacy
  return next
}
