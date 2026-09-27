import { composeRubatoExtension } from "../../../../packages/rubato-runtime/src/extension/compose";
import { createRubatoComponents } from "../../../../packages/rubato-runtime/src/extension/component-list";
import type { RubatoComponent } from "../../../../packages/rubato-runtime/src/extension/types";

type RubatoExtensionOptions = {
  resolveCwd?: () => string;
  createTaskOptions?: (module: any) => any;
};

// Candidate builds must surface failed registration; the legacy optional startup policy is unchanged.
const candidateLogger = {
  info: (message: string, details?: any) => console.info(message, details),
  warn: (message: string, details?: any) => {
    if (message.includes("ExtensionAPI version mismatch") || message.includes("component skipped")) throw new Error(`${message}: ${JSON.stringify(details)}`);
    console.warn(message, details);
  },
  error: (message: string, details?: any) => { throw new Error(`${message}: ${String(details?.component ?? "unknown")}`, { cause: details?.error }); },
};

function lazyTaskComponent(options: RubatoExtensionOptions): RubatoComponent {
  return {
    name: "task",
    async register(pi, ctx) {
      const taskModule = await import("#rubato-task-runtime");
      const taskOptions = options.createTaskOptions?.(taskModule);
      await taskModule.createTaskComponent(taskOptions).register(pi, ctx);
    },
  };
}

// Existing components remain the implementation owners.
export const createRubatoComponentExtension = (options: RubatoExtensionOptions = {}) => {
  const { createTaskOptions: _createTaskOptions, ...componentOptions } = options;
  return composeRubatoExtension(createRubatoComponents(lazyTaskComponent(options), componentOptions), { logger: candidateLogger });
};

// A team member's Agent/AgentSend/AgentCancel, which its prompt promises. Memory stays out: it is
// bound to the lead's identity (task children never inherit it either).
export const createRubatoTaskExtension = (options: RubatoExtensionOptions = {}) =>
  composeRubatoExtension([lazyTaskComponent(options)], { logger: candidateLogger });

export default createRubatoComponentExtension();
