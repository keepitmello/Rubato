const packageName = "@earendil-works/pi-coding-agent";
const version = "0.85.1";

// These hashes are the selected stock Pi 0.85.1 files.  Runtime staging refuses
// to apply this feature when a different package build is present.
const hashes = {
  "dist/core/agent-session-services.js": "3a4ee476b0596f346023398f52176381355f98dd621b8161f269c7ef3a57e28f",
  "dist/core/agent-session-services.d.ts": "ab5dac8701f02587db54abc27d119ea44ebd3708f235d5daf8293abd7b2ea71e",
  "dist/main.js": "f0b7e5a8419af8d149ffe367af2992c76ce70b73484c15492bd50787d4f4962a",
  "dist/main.d.ts": "cf197873ee07f73d5682fe2236e24989714d1f5c1acf8820264e570a5c17dadc",
};

function once(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`runtime-factories patch anchor mismatch: ${before}`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

const transforms = {
  "dist/core/agent-session-services.js": (source) => {
    const marker = `    const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);`;
    const insertion = `${marker}
    const resourceLoaderOptions = options.resourceLoaderOptions ?? {};
    const dynamicExtensionFactories = options.createExtensionFactories === undefined
        ? []
        : await options.createExtensionFactories({ cwd, agentDir, settingsManager, modelRuntime });
    if (!Array.isArray(dynamicExtensionFactories)) {
        throw new TypeError("createExtensionFactories must return an array");
    }
    const extensionFactories = [
        ...(resourceLoaderOptions.extensionFactories ?? []),
        ...dynamicExtensionFactories,
    ];`;
    let next = once(source, marker, insertion);
    return once(next,
      `    const resourceLoader = new DefaultResourceLoader({
        ...(options.resourceLoaderOptions ?? {}),
        cwd,
        agentDir,
        settingsManager,
    });`,
      `    const resourceLoader = new DefaultResourceLoader({
        ...resourceLoaderOptions,
        extensionFactories,
        cwd,
        agentDir,
        settingsManager,
    });`);
  },
  "dist/core/agent-session-services.d.ts": (source) => {
    let next = once(source,
      'import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";',
      'import type { InlineExtension, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";');
    next = once(next,
      "export interface CreateAgentSessionServicesOptions {",
      `export type CreateExtensionFactories = (context: {
    cwd: string;
    agentDir: string;
    settingsManager: SettingsManager;
    modelRuntime: ModelRuntime;
}) => InlineExtension[] | Promise<InlineExtension[]>;
export interface CreateAgentSessionServicesOptions {`);
    return once(next,
      "    modelRuntimeSignal?: AbortSignal;",
      "    modelRuntimeSignal?: AbortSignal;\n    createExtensionFactories?: CreateExtensionFactories;");
  },
  "dist/main.js": (source) => once(source,
    `            modelRuntimeSignal: AbortSignal.timeout(15_000),`,
    `            modelRuntimeSignal: AbortSignal.timeout(15_000),
            createExtensionFactories: options?.createExtensionFactories,`),
  "dist/main.d.ts": (source) => {
    let next = once(source,
      'import type { InlineExtension } from "./core/extensions/types.ts";',
      'import type { InlineExtension } from "./core/extensions/types.ts";\nimport type { CreateExtensionFactories } from "./core/agent-session-services.ts";');
    return once(next,
      "    extensionFactories?: InlineExtension[];",
      "    extensionFactories?: InlineExtension[];\n    createExtensionFactories?: CreateExtensionFactories;");
  },
};

export const patches = Object.entries(transforms).map(([path, apply]) => ({
  id: path,
  packageName,
  version,
  path,
  preimageSha256: hashes[path],
  apply,
}));
