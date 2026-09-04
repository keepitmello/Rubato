import { assertEngineBuilt, rubatoExtension } from "../engine-paths.mjs";
import { runOrDeferExtension } from "../deferred-extensions.mjs";
import { RUBATO_OWNED_COMPONENTS } from "../policy.mjs";

assertEngineBuilt();

const RUBATO_OWNED = new Set(RUBATO_OWNED_COMPONENTS);
const activatingByPi = new WeakMap();

async function activateLeadOverlay(pi) {
  const existing = activatingByPi.get(pi);
  if (existing) return existing;
  const activating = (async () => {
    const [{ composeRubatoExtension, rubatoComponents }, { rubatoPiMemoryComponent, rubatoPiTaskComponent }] = await Promise.all([
      import(rubatoExtension),
      import("../rubato-runtime.mjs"),
    ]);
    const replaceMemory = rubatoPiMemoryComponent !== undefined;
    await composeRubatoExtension([
      ...rubatoComponents.filter((component) => RUBATO_OWNED.has(component.name) && component.name !== "task" && (!replaceMemory || component.name !== "memory")),
      rubatoPiTaskComponent,
      ...(replaceMemory ? [rubatoPiMemoryComponent] : []),
    ])(pi);
  })();
  activatingByPi.set(pi, activating);
  return activating;
}

export default async function leadOverlay(pi) {
  return runOrDeferExtension(() => activateLeadOverlay(pi));
}
