import type { RubatoMemoryDreamModel } from "@rubato/config-core"

import type { DreamRung } from "./runner"

/** `memory.dream.models` as launchable rungs, in order; entries that are not "<provider>/<id>" and repeats drop. */
export function dreamLadder(models: readonly RubatoMemoryDreamModel[]): DreamRung[] {
  const rungs: DreamRung[] = []
  for (const entry of models) {
    const { model, reasoning } = typeof entry === "string" ? { model: entry, reasoning: undefined } : entry
    if (!model.includes("/")) continue
    if (rungs.some((rung) => rung.model === model)) continue
    rungs.push(reasoning === undefined ? { model } : { model, thinking: reasoning })
  }
  return rungs
}
