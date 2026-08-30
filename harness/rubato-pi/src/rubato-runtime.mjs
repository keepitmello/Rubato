import { rubatoTaskExtension } from "./engine-paths.mjs";
import { loadRubatoPiRubatoConfig, pinMemoryJobsToGrok } from "./rubato-config.mjs";
import { loadRubatoExtension } from "./rubato-entry.mjs";

const { createTaskComponent } = await import(rubatoTaskExtension);
const rubatoModule = await loadRubatoExtension();

export const rubatoPiTaskComponent = createTaskComponent({
  loadConfig: loadRubatoPiRubatoConfig,
});

function loadMemoryConfig(options = {}) {
  const base = typeof rubatoModule.loadSenpiRubatoConfig === "function"
    ? rubatoModule.loadSenpiRubatoConfig(options)
    : loadRubatoPiRubatoConfig(options);
  return pinMemoryJobsToGrok(base);
}

export const rubatoPiMemoryComponent = typeof rubatoModule.createMemoryComponent === "function"
  ? rubatoModule.createMemoryComponent({ loadConfig: loadMemoryConfig })
  : undefined;
