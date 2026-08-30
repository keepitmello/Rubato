import { assertEngineBuilt, rubatoExtension } from "../engine-paths.mjs";
import { rubatoPiMemoryComponent, rubatoPiTaskComponent } from "../rubato-runtime.mjs";
import { RUBATO_OWNED_COMPONENTS } from "../policy.mjs";

assertEngineBuilt();
const { composeRubatoExtension, rubatoComponents } = await import(rubatoExtension);

const RUBATO_OWNED = new Set(RUBATO_OWNED_COMPONENTS);

const replaceMemory = rubatoPiMemoryComponent !== undefined;
export default composeRubatoExtension([
  ...rubatoComponents.filter((component) => RUBATO_OWNED.has(component.name) && component.name !== "task" && (!replaceMemory || component.name !== "memory")),
  rubatoPiTaskComponent,
  ...(replaceMemory ? [rubatoPiMemoryComponent] : []),
]);
