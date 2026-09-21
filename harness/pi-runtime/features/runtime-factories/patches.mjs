const packageName = "@earendil-works/pi-coding-agent";
const version = "0.86.1";

// These hashes are the selected stock Pi 0.86.1 files.  Runtime staging refuses
// to apply this feature when a different package build is present.
const hashes = {
  "dist/core/agent-session-services.js": "3a4ee476b0596f346023398f52176381355f98dd621b8161f269c7ef3a57e28f",
  "dist/core/agent-session-services.d.ts": "ab5dac8701f02587db54abc27d119ea44ebd3708f235d5daf8293abd7b2ea71e",
  "dist/main.js": "e36837e55af695cbb95216763fbc929e87829ced837dd32f281bba8c8e50035c",
  "dist/main.d.ts": "cf197873ee07f73d5682fe2236e24989714d1f5c1acf8820264e570a5c17dadc",
};

function once(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`runtime-factories patch anchor mismatch: ${before}`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

// The CLI and a shared host must use the SAME project trust, model selection,
// settings and resource bootstrap. Move the stock closure; do not copy its
// policy into a second SDK-only implementation.
function extractCliRuntimeFactory(source) {
  const start = source.indexOf("    const trustStore = new ProjectTrustStore(agentDir);");
  const end = source.indexOf('    time("createRuntime");', start);
  if (start < 0 || end < 0 || source.includes("export function createCliRuntimeFactory(")) throw new Error("runtime-factories factory extraction anchor mismatch");
  const original = source.slice(start, end);
  const selection = `    const sessionCwd = sessionManager.getCwd();
    const autoTrustOnReloadCwd = parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
        ? sessionCwd
        : undefined;
`;
  const body = once(once(original, selection, ""), 'createExtensionFactories: options?.createExtensionFactories,', 'createExtensionFactories,');
  const replacement = `${selection}    const createRuntime = createCliRuntimeFactory({
        cwd, agentDir, parsed, appMode, startupSettingsManager, extensionFactories, options,
    });
`;
  const declaration = `export function createCliRuntimeFactory({ cwd, agentDir, parsed, appMode, startupSettingsManager, extensionFactories = builtInExtensions, options }) {
    const createExtensionFactories = options?.createExtensionFactories;
${body}    return createRuntime;
}

`;
  let next = source.slice(0, start) + replacement + source.slice(end);
  return once(next, "export async function main(", declaration + "export async function main(");
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
  "dist/main.js": (source) => extractCliRuntimeFactory(once(source,
    `            modelRuntimeSignal: AbortSignal.timeout(15_000),`,
    `            modelRuntimeSignal: AbortSignal.timeout(15_000),
            createExtensionFactories: options?.createExtensionFactories,`)),
  "dist/main.d.ts": (source) => {
    let next = once(source,
      'import type { InlineExtension } from "./core/extensions/types.ts";',
      'import type { InlineExtension } from "./core/extensions/types.ts";\nimport type { CreateExtensionFactories } from "./core/agent-session-services.ts";');
    next = once(next,
      "    extensionFactories?: InlineExtension[];",
      "    extensionFactories?: InlineExtension[];\n    createExtensionFactories?: CreateExtensionFactories;");
    return once(next, "export declare function main(", `export declare function createCliRuntimeFactory(context: {
    cwd: string;
    agentDir: string;
    parsed: Args;
    appMode: "interactive" | "rpc" | "print";
    startupSettingsManager: SettingsManager;
    extensionFactories?: InlineExtension[];
    options?: MainOptions;
}): import("./core/agent-session-runtime.ts").CreateAgentSessionRuntimeFactory;
export declare function main(`);
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
