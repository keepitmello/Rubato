import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_VERSION } from "./pi-version.mjs";
import { DefaultResourceLoader, SettingsManager, createAgentSession } from "../../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { createPiRpcSpawnRuntime, createStockChildInProcessSession, loadPiChildInProcessFactories, resolvePiChildProviderProfile, resolveStockRpcEntry } from "../child-runtime/stock-rpc-runtime.mjs";
import { createMcpProducerRegistry } from "../mcp-producers/index.mjs";
import { createMcpExtension } from "../mcp/index.mjs";
import { ToolSearchService, createToolSearchExtension } from "../tool-search/index.mjs";
import { createServiceTierFeature } from "../service-tier/extension.mjs";
import terminal from "../terminal/src/index.ts";
import mediaTools from "../media-tools/src/index.mjs";
import { loopGuardExtension, registerApplyPatchExtension, toolPairGuardExtension } from "../tool-guards/index.mjs";
import { createBashTimeoutExtension, createHooksExtension, createPermissionExtension } from "../tool-policy/index.mjs";
import { createProvidersExtension } from "../../node_modules/@earendil-works/pi-ai/dist/rubato-features/providers/extension.mjs";
import { createProviderExecution } from "../../node_modules/@earendil-works/pi-ai/dist/rubato-features/provider-execution/extension.mjs";
import { createGptAccountExtension } from "../../node_modules/@earendil-works/pi-ai/dist/rubato-features/providers/auth-pool/gpt-account.mjs";
import { createContextNotesExtension } from "../../node_modules/@earendil-works/pi-coding-agent/dist/rubato-features/context-notes/extension.mjs";
import { createPromptRulesExtensionFactories, createTodoExtension } from "../prompt-rules/index.mjs";
import { createCompactionExtensionFactories } from "../compaction/index.mjs";
import { createConfigReloadExtensionFactories } from "../config-reload/index.mjs";
import { createGoalExtension, createUserCommandsAgentFactories } from "../user-commands-agent/index.mjs";
import { createUserCommandSessionFactories } from "../user-commands-session/index.mjs";
import { createSessionTitleFactories } from "../session-title/index.mjs";
import { createSessionLinkFactories } from "../session-link/index.mjs";
import { createAdapterHookFactories } from "../adapter-hooks/index.mjs";
import { createRemoteSurfaceFactories } from "../remote-surface/index.mjs";
import { createTuiInputFactories } from "../tui-input/index.mjs";
import codemode from "../codemode/src/index.ts";
import { createRemovedToolHintRegistrar } from "../codemode/src/extension/stock-host-adapter.ts";
import { createRubatoChildComponentExtension, createRubatoComponentExtension } from "./extensions/rubato.js";
import { validateBuildReceipt } from "./payload-manifest.mjs";
import { applyFeatureToggles, readDisabledFeatures } from "./feature-toggles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export async function validateRubatoBundleAssets() {
  const receipt = JSON.parse(await readFile(join(here, "rubato-build.json"), "utf8"));
  const lockSha256 = createHash("sha256").update(await readFile(new URL("../../package-lock.json", import.meta.url))).digest("hex");
  const payloads = validateBuildReceipt(receipt, { stockVersion: PI_VERSION, lockSha256 });
  for (const entry of payloads) {
    const path = entry.path;
    const resolved = await realpath(join(here, path));
    const rel = relative(await realpath(here), resolved);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error(`Rubato asset escaped bundle root: ${path}`);
    const actual = createHash("sha256").update(await readFile(resolved)).digest("hex");
    if (actual !== entry.sha256) throw new Error(`Required Rubato bundle hash mismatch: ${path}`);
  }
}

/** Explicit stock ExtensionFactory assembly; no session/agent-loop replacement.
 * Current selected features only. The stage receipt continues to deny full parity.
 */
export function createRubatoExtensionFactories({ cwd, agentDir, settingsManager, modelRuntime, codemodeOptions, mcpOptions = {}, terminalOptions = {}, providerOptions = {}, env = process.env, hosted = false, sessionLink } = {}) {
  if (!cwd || !agentDir) throw new Error("Rubato candidate requires explicit cwd and agentDir");
  if (!modelRuntime || typeof modelRuntime.streamSimple !== "function") throw new Error("Rubato candidate requires the parent's canonical stock ModelRuntime");
  const settings = settingsManager ?? SettingsManager.create(cwd, agentDir);
  const servers = createMcpProducerRegistry({ registrationCwd: cwd });
  const toolSearch = new ToolSearchService();
  const serviceTier = createServiceTierFeature({ agentDir, settingsManagerFactory: () => settings });
  const providerExecution = createProviderExecution({ cursorProviderFactory: providerOptions.routeFactories?.cursor });
  const componentFactory = servers.wrapFactory(createRubatoComponentExtension({ resolveCwd: () => cwd, createTaskOptions: ({ createTaskRunnerFactories }) => ({
    // Stock ExtensionAPI does not expose Senpi's registration-time pi.cwd.
    // Bind task storage to this session, never the hosting process directory.
    resolveCwd: () => cwd,
    runnerFactories: createStockTaskRunnerFactories({ agentDir, modelRuntime, createTaskRunnerFactories }),
  }) }), { sourcePath: join(here, "extensions/rubato.js"), registrationCwd: cwd });
  const extensionFactories = [
    { name: "rubato-assets", factory: async () => validateRubatoBundleAssets() },
    { name: "rubato-loop-guard", factory: loopGuardExtension },
    { name: "rubato-hooks", factory: createHooksExtension({
      agentDir,
      isTrusted: async (handler) => handler.source?.sourcePath === join(agentDir, "hooks.json"),
    }) },
    { name: "rubato-permission", factory: createPermissionExtension() },
    { name: "providers", factory: createProvidersExtension({ ...providerOptions,
      routeFactories: { ...providerOptions.routeFactories, cursor: providerExecution.cursorRouteFactory },
      agentDir,
      modelRuntime,
      env: { ...env, ...providerOptions.env, RUBATO_PI_CODING_AGENT_DIR: agentDir } }) },
    { name: "rubato-multi-account", factory: createGptAccountExtension({
      agentDir,
      env: { ...env, ...providerOptions.env, RUBATO_PI_CODING_AGENT_DIR: agentDir },
    }) },
    { name: "provider-execution", factory: providerExecution.extension },
    { name: "service-tier", factory: serviceTier.extension },
    { name: "rubato-gpt-apply-patch", factory: registerApplyPatchExtension },
    // The compaction overlay reads the session's resolved mode from `env`. A hosted worker's
    // env is its own copy, so writing it reaches only this worker; the server's shared
    // process.env is never written.
    { name: "context-notes", factory: createContextNotesExtension({ agentDir, settingsManager: settings, env, propagateEnv: !hosted || env !== process.env }) },
    ...createCompactionExtensionFactories({ settingsManager: settings, env }),
    ...createPromptRulesExtensionFactories({ settingsManager: settings }),
    ...createConfigReloadExtensionFactories({ settingsManager: settings, agentDir, cwd }),
    ...createUserCommandsAgentFactories({ agentDir, env }),
    ...createUserCommandSessionFactories(),
    ...createSessionTitleFactories(),
    // `sessionLink` comes from the engine (pi-server hosted-runtime.mjs); outside it the tools stay unregistered.
    ...createSessionLinkFactories({ sessionLink }),
    ...createAdapterHookFactories(),
    ...createRemoteSurfaceFactories({ env, hosted }),
    ...createTuiInputFactories(),
    { name: "rubato-bash-timeout", factory: createBashTimeoutExtension() },
    { name: "terminal", factory: (pi) => terminal(pi, { ...terminalOptions, createSettingsManager: () => settings }) },
    { name: "media-tools", factory: (pi) => mediaTools(pi, { createSettingsManager: () => settings }) },
    { name: "codemode", factory: (pi) => codemode(pi, codemodeOptions) },
    { name: "tool-search", factory: createToolSearchExtension(toolSearch) },
    { name: "rubato-components", factory: withRemovedToolHints(componentFactory) },
    { name: "mcp", factory: createMcpExtension({ ...mcpOptions, agentDir, servers, toolSearchService: toolSearch }) },
    { name: "rubato-tool-pair-guard", factory: toolPairGuardExtension },
    { name: "service-tier-consumers", factory: (pi) => {
      let unsubscribe;
      pi.rpc.handle("rubato.service-tier.status", () => serviceTier.getState());
      pi.on("session_start", (_event, ctx) => {
        unsubscribe?.();
        const update = (state) => {
          ctx.ui.setStatus("rubato-fast", state.active ? "⚡ Fast" : undefined);
          pi.rpc.emit("rubato.service-tier.updated", state);
        };
        unsubscribe = serviceTier.onChange(update);
      });
      pi.on("session_shutdown", () => { unsubscribe?.(); unsubscribe = undefined; });
    } },
  ];
  const toggles = applyFeatureToggles(extensionFactories, readDisabledFeatures({ agentDir, env }));
  return { extensionFactories: toggles.extensionFactories, disabledFeatures: toggles.disabled, unknownDisabledFeatures: toggles.unknown,
    servers, toolSearch, serviceTier, settingsManager: settings };
}

const runtimeRoot = fileURLToPath(new URL("../..", import.meta.url));

// Codemode owns the removed-tool hints; components reach them through the host they register on.
function withRemovedToolHints(componentFactory) {
  return async (pi) => {
    const registerRemovedToolHint = createRemovedToolHintRegistrar(pi);
    const host = new Proxy(pi, { get(target, key, receiver) {
      if (key === "registerRemovedToolHint") return registerRemovedToolHint;
      return Reflect.get(target, key, receiver);
    } });
    await componentFactory(host);
  };
}

/**
 * A task child's extensions: the lead's working tools. What stays with the lead is memory (bound
 * to the lead's identity), team management and Agent (a team member keeps Agent), and the surfaces
 * that serve a person at the lead (remote, titles, slash commands, UI status). The child profile in
 * child-runtime (providers, notes, guards, role prompt, service tier) loads beside this.
 *
 * `sharesParentTools`: an in-process child already receives the lead's registered component tools
 * (lsp) as shared parent tools, so it must not register a second copy.
 */
export function createRubatoChildExtensionFactories({ cwd, agentDir, settingsManager, env = process.env, member = false,
  sharesParentTools = false, createTaskOptions } = {}) {
  if (!cwd || !agentDir) throw new Error("Rubato child requires explicit cwd and agentDir");
  if (member && createTaskOptions === undefined) throw new Error("A team member's Agent needs its task runners");
  const settings = settingsManager ?? SettingsManager.create(cwd, agentDir);
  const servers = createMcpProducerRegistry({ registrationCwd: cwd });
  const toolSearch = new ToolSearchService();
  const components = ["ast-grep", ...(sharesParentTools ? [] : ["lsp"]), ...(member ? ["task"] : [])];
  const componentFactory = servers.wrapFactory(createRubatoChildComponentExtension({ resolveCwd: () => cwd, components,
    ...(createTaskOptions === undefined ? {} : { createTaskOptions }) }), { sourcePath: join(here, "extensions/rubato.js"), registrationCwd: cwd });
  const extensionFactories = [
    { name: "rubato-gpt-apply-patch", factory: registerApplyPatchExtension },
    { name: "rubato-todo", factory: createTodoExtension() },
    { name: "rubato-goal", factory: createGoalExtension({ agentDir, env }) },
    { name: "rubato-bash-timeout", factory: createBashTimeoutExtension() },
    { name: "terminal", factory: (pi) => terminal(pi, { createSettingsManager: () => settings }) },
    { name: "media-tools", factory: (pi) => mediaTools(pi, { createSettingsManager: () => settings }) },
    { name: "codemode", factory: (pi) => codemode(pi) },
    { name: "tool-search", factory: createToolSearchExtension(toolSearch) },
    { name: "rubato-components", factory: withRemovedToolHints(componentFactory) },
    { name: "mcp", factory: createMcpExtension({ agentDir, servers, toolSearchService: toolSearch }) },
  ];
  // A feature the user turned off stays off in the lead's children too.
  return applyFeatureToggles(extensionFactories, readDisabledFeatures({ agentDir, env })).extensionFactories;
}

/**
 * The task runners of a stock session, lead or team member. Every RPC child boots child-rpc-entry
 * (the child extensions above) with the child profile; an in-process child shares this session's
 * ModelRuntime and gets the same child extensions in-process.
 */
export function createStockTaskRunnerFactories({ agentDir, modelRuntime, createTaskRunnerFactories, env = process.env }) {
  const rpcSpawnRuntime = createPiRpcSpawnRuntime({ rpcEntry: resolveStockRpcEntry({ root: runtimeRoot }) });
  const stockChildProfile = resolvePiChildProviderProfile({ root: runtimeRoot, agentDir, includeContextNotes: true,
    includeGuards: true, includeRolePrompt: true });
  // An in-process child runs in this process, so it would read this process's role (a member's
  // owner/verifier). Whoever spawns it, a task child is an agent.
  const childEnv = { ...env, RUBATO_PI_ROLE: "agent" };
  return createTaskRunnerFactories({ rpcSpawnRuntime, stockChildProfile, stockModelRuntime: modelRuntime,
    createInProcessSession: async (options) => {
      // The factory list is per child. An unset tier must not pass serviceTier, or every
      // in-process child would load the extension the parent profile deliberately omits.
      const serviceTier = options.serviceTier;
      const childAgentDir = options.agentDir ?? agentDir;
      return createStockChildInProcessSession(options, {
        createAgentSession,
        DefaultResourceLoader,
        extensionFactories: [
          ...await loadPiChildInProcessFactories({ root: runtimeRoot, agentDir: childAgentDir, settingsManager: options.settingsManager,
            propagateEnv: false, env: childEnv, ...(serviceTier === undefined ? {} : { serviceTier }) }),
          ...createRubatoChildExtensionFactories({ cwd: options.cwd, agentDir: childAgentDir, settingsManager: options.settingsManager,
            env: childEnv, sharesParentTools: true }),
        ],
      });
    } });
}
