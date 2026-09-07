import { composeRubatoExtension } from "../../../../packages/rubato-runtime/src/extension/compose";
import { createRubatoComponents } from "../../../../packages/rubato-runtime/src/extension/component-list";
import type { RubatoComponent } from "../../../../packages/rubato-runtime/src/extension/types";

// Existing components remain the implementation owners. Candidate builds must
// surface failed registration; the legacy optional startup policy is unchanged.
export const createRubatoComponentExtension = (options: { createTaskOptions?: (module: any) => any } = {}) => {
  const task: RubatoComponent = {
    name: "task",
    async register(pi, ctx) {
      const taskModule = await import("#rubato-task-runtime");
      const taskOptions = options.createTaskOptions?.(taskModule);
      await taskModule.createTaskComponent(taskOptions).register(pi, ctx);
    },
  };
  return composeRubatoExtension(createRubatoComponents(task), { logger: {
  info: (message, details) => console.info(message, details),
  warn: (message, details) => {
    if (message.includes("ExtensionAPI version mismatch") || message.includes("component skipped")) throw new Error(`${message}: ${JSON.stringify(details)}`);
    console.warn(message, details);
  },
  error: (message, details) => { throw new Error(`${message}: ${String(details?.component ?? "unknown")}`, { cause: details?.error }); },
  } });
};
export default createRubatoComponentExtension();
