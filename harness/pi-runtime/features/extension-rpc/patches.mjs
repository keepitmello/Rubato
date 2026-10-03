import { fileURLToPath } from "node:url";

const packageName = "@earendil-works/pi-coding-agent";
import { PI_VERSION as version } from "../../pi-version.mjs";
const hashes = {
  "dist/core/extensions/loader.js": "44a356da552c9cf2ea619c61944cfb28f81b45f09b325f152c91a914bfce1bc0",
  "dist/core/extensions/types.d.ts": "abd9e9be0bf21b4c35621fe90b79af75c85b774e8b254b515d699785fda5962a",
  "dist/core/extensions/runner.js": "258f142bc56cc84d953ef6146222e5ff3a94cc908592a1b3d075d34bbcd68b36",
  "dist/core/extensions/runner.d.ts": "6aef77e094e73abd7e508850e45c58e244ab2d5db6c4f6278d8652ea9ded2bb1",
  "dist/modes/rpc/rpc-mode.js": "631697cd35928fc827f4a423538c43ff227b8cbf63c2a2f11060616f55eba6db",
  "dist/modes/rpc/rpc-types.d.ts": "68b6dc2e47a3969c09c961a40d0462473407b6786f3bd02715fa035e816e2af1",
  "dist/modes/print-mode.js": "f2eb170b9620c1d37e68b788ff71257a4402a23e7f3999575feee8e5d9e13b3f",
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
    `import { collectPendingWork, requestExtensionRpc } from "../../rubato-features/extension-rpc/runtime.mjs";\n` +
    once(source, "    getCommand(name) {", `    requestRpc(name, data) {
        return requestExtensionRpc(this.extensions, () => this.assertActive(), name, data);
    }
    pendingWork() {
        return collectPendingWork(this.extensions, () => this.assertActive());
    }
    getCommand(name) {`),
  "dist/core/extensions/runner.d.ts": (source) => once(source, "    getCommand(name: string): ResolvedCommand | undefined;",
    "    requestRpc(name: string, data?: unknown): Promise<unknown>;\n    pendingWork(): Promise<{ active: number; undelivered: number }>;\n    getCommand(name: string): ResolvedCommand | undefined;"),
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
  // A one-shot run stays until the session is idle with no `*.pending-work` left (runtime.mjs).
  "dist/modes/print-mode.js": (source) =>
    `import { holdForPendingWork } from "../rubato-features/extension-rpc/runtime.mjs";\n` +
    once(source, "        for (const message of messages) {\n            await session.prompt(message);\n        }\n",
      "        for (const message of messages) {\n            await session.prompt(message);\n        }\n        await holdForPendingWork(() => session);\n"),
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
