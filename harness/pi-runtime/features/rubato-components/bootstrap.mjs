import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsManager, createAgentSession } from "../../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { createStockRpcSpawnRuntime } from "../child-runtime/stock-rpc-runtime.mjs";
import { createMcpProducerRegistry } from "../mcp-producers/index.mjs";
import { createMcpExtension } from "../mcp/index.mjs";
import { ToolSearchService, createToolSearchExtension } from "../tool-search/index.mjs";
import { createServiceTierFeature } from "../service-tier/extension.mjs";
import terminal from "../terminal/src/index.ts";
import { createProvidersExtension } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/rubato-features/providers/extension.mjs";
import codemode from "../codemode/src/index.ts";
import { createRemovedToolHintRegistrar } from "../codemode/src/extension/stock-host-adapter.ts";
import { createRubatoComponentExtension } from "./extensions/rubato.js";
import { validateBuildReceipt } from "./payload-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export async function validateRubatoBundleAssets() {
  const receipt = JSON.parse(await readFile(join(here, "rubato-build.json"), "utf8"));
  const lockSha256 = createHash("sha256").update(await readFile(new URL("../../package-lock.json", import.meta.url))).digest("hex");
  const payloads = validateBuildReceipt(receipt, { stockVersion: "0.85.1", lockSha256 });
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
export function createRubatoExtensionFactories({ cwd, agentDir, settingsManager, modelRuntime, codemodeOptions, mcpOptions = {}, terminalOptions = {}, providerOptions = {} } = {}) {
  if (!cwd || !agentDir) throw new Error("Rubato candidate requires explicit cwd and agentDir");
  if (!modelRuntime || typeof modelRuntime.streamSimple !== "function") throw new Error("Rubato candidate requires the parent's canonical stock ModelRuntime");
  const settings = settingsManager ?? SettingsManager.create(cwd, agentDir);
  const servers = createMcpProducerRegistry({ registrationCwd: cwd });
  const toolSearch = new ToolSearchService();
  const serviceTier = createServiceTierFeature({ agentDir, settingsManagerFactory: () => settings });
  const rpcSpawnRuntime = createStockRpcSpawnRuntime({
    rpcEntry: fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js", import.meta.url)),
  });
  const componentFactory = servers.wrapFactory(createRubatoComponentExtension({ createTaskOptions: ({ createTaskRunnerFactories }) => ({
    runnerFactories: createTaskRunnerFactories({ rpcSpawnRuntime, stockModelRuntime: modelRuntime,
      createInProcessSession: async (options) => (await createAgentSession(options)).session }),
  }) }), { sourcePath: join(here, "extensions/rubato.js"), registrationCwd: cwd });
  const extensionFactories = [
    { name: "rubato-assets", factory: async () => validateRubatoBundleAssets() },
    { name: "providers", factory: createProvidersExtension({ ...providerOptions,
      env: { ...process.env, ...providerOptions.env, RUBATO_PI_CODING_AGENT_DIR: agentDir } }) },
    { name: "service-tier", factory: serviceTier.extension },
    { name: "terminal", factory: (pi) => terminal(pi, { ...terminalOptions, createSettingsManager: () => settings }) },
    { name: "codemode", factory: (pi) => codemode(pi, codemodeOptions) },
    { name: "tool-search", factory: createToolSearchExtension(toolSearch) },
    { name: "rubato-components", factory: async (pi) => {
      const registerRemovedToolHint = createRemovedToolHintRegistrar(pi);
      const host = new Proxy(pi, { get(target, key, receiver) {
        if (key === "registerRemovedToolHint") return registerRemovedToolHint;
        return Reflect.get(target, key, receiver);
      } });
      await componentFactory(host);
    } },
    { name: "mcp", factory: createMcpExtension({ ...mcpOptions, agentDir, servers, toolSearchService: toolSearch }) },
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
  return { extensionFactories, servers, toolSearch, serviceTier, settingsManager: settings };
}
