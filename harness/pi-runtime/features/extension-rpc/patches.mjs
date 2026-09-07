import { fileURLToPath } from "node:url";

const packageName = "@earendil-works/pi-coding-agent";
const version = "0.85.1";
const hashes = {
  "dist/core/extensions/loader.js": "a1393de916487a2c47107ac7239f3139dcdb938705f88ba1ea5a954b3c8bb483",
  "dist/core/extensions/types.d.ts": "5baa29ca2f541f71f81a400dec25903abfbd03980bd4d9b691d10353e52d169a",
  "dist/core/extensions/runner.js": "0de12ed1275e02595f92476eec3f61ae1f2e54fd2225ced721ddc90af58a5e61",
  "dist/core/extensions/runner.d.ts": "5e6f5e8e5dffccc0f7e235964a75ac181d2c6e06b924e149370ad688a31d7193",
  "dist/modes/rpc/rpc-mode.js": "e7e4724aa55c5aac73cf36793653b26736200e5c59d58373990fc31028f86477",
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
