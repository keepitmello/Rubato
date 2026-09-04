import { assertEngineBuilt, rubatoExtension } from "../engine-paths.mjs";
import { registerDeferredExtension, shouldDeferExtensionActivation } from "../deferred-extensions.mjs";
import { RUBATO_OWNED_COMPONENTS } from "../policy.mjs";

assertEngineBuilt();

const RUBATO_OWNED = new Set(RUBATO_OWNED_COMPONENTS);
let activating;

async function activateLeadOverlay(pi) {
  if (activating) return activating;
  activating = (async () => {
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
  return activating;
}

export default async function leadOverlay(pi) {
  registerDeferredExtension(() => activateLeadOverlay(pi));
  if (!shouldDeferExtensionActivation()) return activateLeadOverlay(pi);
}
