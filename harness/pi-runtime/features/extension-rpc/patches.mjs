import { fileURLToPath } from "node:url";

const packageName = "@earendil-works/pi-coding-agent";
const version = "0.86.1";
const hashes = {
  "dist/core/extensions/loader.js": "81106b07522aaf9197858c4679fecd7fbd23c346376d6e1f2cc3dd5294d543f4",
  "dist/core/extensions/types.d.ts": "a4d5b8774fa8015b8a3274614f1398a6aeeffdd888c122910439666955dc2a52",
  "dist/core/extensions/runner.js": "07a94efe560e6a460a415b2188c1c3c69ca151bd163c9b5f05347caf8403ace2",
  "dist/core/extensions/runner.d.ts": "fc0f81468c51bacfc093ac09974aa8e8053ca463e205eb66a1c63b0b655f61b9",
  "dist/modes/rpc/rpc-mode.js": "bdd94e753e6d19731d9fb9ea370462d095d64f1e78bddd7651320663fa57c4ff",
  "dist/modes/rpc/rpc-types.d.ts": "e968e5be01dc7ad9615f938ae867ef136fa495f13dcf169942e9f781a299d9eb",
};
function once(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) throw new Error(`extension-rpc patch anchor mismatch: ${before}`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}
const transforms = {
  "dist/core/extensions/loader.js": (source) =>
    `import { createExtensionRpc } from "../../rubato-features/extension-rpc/runtime.mjs";\n` +
    once(source, "        events: {", "        rpc: createExtensionRpc(extension, assertActive, eventBus),\n        events: {"),
  "dist/core/extensions/types.d.ts": (source) => {
    let next = once(source, "export interface ExtensionAPI {", `export interface ExtensionAPI {
    readonly rpc: {
        emit(name: string, data?: unknown): void;
        handle(name: string, handler: (data: unknown) => unknown | Promise<unknown>): void;
    };`);
    return once(next, "export interface Extension {", "export interface Extension {\n    rpcHandlers?: Map<string, (data: unknown) => unknown | Promise<unknown>>;");
  },
  "dist/core/extensions/runner.js": (source) =>
    `import { requestExtensionRpc } from "../../rubato-features/extension-rpc/runtime.mjs";\n` +
    once(source, "    getCommand(name) {", `    requestRpc(name, data) {
        return requestExtensionRpc(this.extensions, () => this.assertActive(), name, data);
    }
    getCommand(name) {`),
  "dist/core/extensions/runner.d.ts": (source) => once(source, "    getCommand(name: string): ResolvedCommand | undefined;",
    "    requestRpc(name: string, data?: unknown): Promise<unknown>;\n    getCommand(name: string): ResolvedCommand | undefined;"),
  "dist/modes/rpc/rpc-mode.js": (source) => {
    let next = `import { EXTENSION_RPC_CHANNEL } from "../../rubato-features/extension-rpc/runtime.mjs";\n${source}`;
    next = once(next, "    let unsubscribeBackpressure;", "    let unsubscribeBackpressure;\n    let unsubscribeExtensionRpc;");
    next = once(next, "        session = runtimeHost.session;\n        await session.bindExtensions({", `        session = runtimeHost.session;
        unsubscribeExtensionRpc?.();
        unsubscribeExtensionRpc = session.resourceLoader.eventBus.on(EXTENSION_RPC_CHANNEL, ({ name, data }) => {
            output({ type: "extension_event", name, data });
        });
        await session.bindExtensions({`);
    // Runtime replacement callbacks may already have rebound the new session.
    // Keep the RPC command fallback, but do not replay session_start on that session.
    const rebind = "                if (!result.cancelled) {\n                    await rebindSession();\n                }";
    if (next.split(rebind).length !== 5) throw new Error("extension-rpc replacement rebind anchor count mismatch");
    next = next.replaceAll(rebind, rebind.replace("!result.cancelled", "!result.cancelled && session !== runtimeHost.session"));
    next = once(next, "            default: {\n                const unknownCommand = command;", `            case "extension_request": {
                const data = await session.extensionRunner.requestRpc(command.name, command.data);
                return success(id, "extension_request", data);
            }
            default: {
                const unknownCommand = command;`);
    return once(next, "        await runtimeHost.dispose();\n        detachInput();", "        unsubscribeExtensionRpc?.();\n        await runtimeHost.dispose();\n        detachInput();");
  },
  "dist/modes/rpc/rpc-types.d.ts": (source) => {
    let next = once(source, "export type RpcCommand = {", `export type RpcCommand = {
    id?: string;
    type: "extension_request";
    name: string;
    data?: unknown;
} | {`);
    return once(next, "export type RpcResponse = {", `export interface ExtensionRpcEvent {
    type: "extension_event";
    name: string;
    data?: unknown;
}
export type RpcResponse = {
    id?: string;
    type: "response";
    command: "extension_request";
    success: true;
    data?: unknown;
} | {`);
  },
};
export const patches = Object.entries(transforms).map(([path, apply]) => ({
  id: path, packageName, version, path, preimageSha256: hashes[path], apply,
}));
export const files = [{ packageName, version, path: "dist/rubato-features/extension-rpc/runtime.mjs",
  sourcePath: fileURLToPath(new URL("./runtime.mjs", import.meta.url)) }];
