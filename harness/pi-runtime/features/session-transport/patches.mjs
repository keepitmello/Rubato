// Preserve Pi's RPC command/UI implementation. A hosted session supplies only
// transport and lifecycle; the existing executable still owns stdio/signals.
const packageName = "@earendil-works/pi-coding-agent";
import { PI_VERSION as version } from "../../pi-version.mjs";
const hashes = {
  "dist/core/agent-session.js": "35ca1dabd54d98c236c9601b569c2856b726ade392d06b2eaaf50158f48913ab",
  "dist/core/agent-session.d.ts": "2e50b35a37f9c7149c6297ae554b2d965bd74dbfcb8ccd7be44f13226ce497e7",
  "dist/modes/rpc/rpc-mode.js": "631697cd35928fc827f4a423538c43ff227b8cbf63c2a2f11060616f55eba6db",
  "dist/modes/rpc/rpc-mode.d.ts": "6c6799bca7017657b3e38e55638bf7233c157082aeb176b90b71343bda3482c4",
};
function once(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) throw new Error(`session-transport anchor mismatch: ${before}`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}
function patchDeclarations(source) {
  if (source.includes("export interface SessionRpcTransport")) throw new Error("session-transport anchor mismatch: declarations already patched");
  return once(source,
    "export declare function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never>;",
    `export interface SessionRpcTransport {
    deferSessionStart?: boolean;
    output(event: unknown): void;
    waitForDrain?(): void | Promise<void>;
    onClose?(error?: unknown): void;
}
export interface SessionRpcController {
    activatePresentation(): Promise<void>;
    dispatch(command: import("./rpc-types.ts").RpcCommand | import("./rpc-types.ts").RpcExtensionUIResponse): Promise<void>;
    close(): Promise<void>;
}
export declare function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never>;
export declare function runRpcMode(runtimeHost: AgentSessionRuntime, transport: SessionRpcTransport): Promise<SessionRpcController>;`);
}
const transforms = {
  "dist/core/agent-session.js": source => {
    if (source.includes('bindings.deferSessionStart')) throw new Error('session-transport anchor mismatch: binding lifecycle already patched');
    return once(source, '        await this._extensionRunner.emit(this._sessionStartEvent);',
      '        if (bindings.deferSessionStart || (bindings.presentationOnly && this._sessionStartEmitted)) return;\n        this._sessionStartEmitted = true;\n        await this._extensionRunner.emit(this._sessionStartEvent);');
  },
  "dist/core/agent-session.d.ts": source => {
    if (source.includes('deferSessionStart?:')) throw new Error('session-transport anchor mismatch: bindings already patched');
    return once(source, 'export interface ExtensionBindings {',
      'export interface ExtensionBindings {\n    presentationOnly?: boolean;\n    deferSessionStart?: boolean;');
  },
  "dist/modes/rpc/rpc-mode.js": (source) => {
    let next = once(source, `export async function runRpcMode(runtimeHost) {
    takeOverStdout();`, `export async function runRpcMode(runtimeHost, transport) {
    if (transport && typeof transport.output !== "function") throw new TypeError("Hosted RPC requires an output callback");
    if (!transport) takeOverStdout();
    const waitForOutput = () => transport ? transport.waitForDrain?.() : waitForRawStdoutBackpressure();`);
    next = once(next, `        writeRawStdout(serializeJsonLine(obj));`, `        if (transport) transport.output(obj);
        else writeRawStdout(serializeJsonLine(obj));`);
    // Match calls, not the import or the wrapper's fallback expression.
    const waits = next.match(/await waitForRawStdoutBackpressure\(\);/g) ?? [];
    if (waits.length !== 4) throw new Error(`session-transport backpressure anchors: ${waits.length}`);
    next = next.replaceAll("await waitForRawStdoutBackpressure();", "await waitForOutput();");
    next = once(next, 'const rebindSession = async () => {', 'const rebindSession = async (presentationOnly = false) => {');
    next = once(next, 'await session.bindExtensions({', 'await session.bindExtensions({\n            presentationOnly,\n            deferSessionStart: !presentationOnly && transport?.deferSessionStart,');
    next = once(next, `    await rebindSession();
    registerSignalHandlers();`, `    try {
        await rebindSession();
    } catch (error) {
        if (transport) {
            for (const pending of pendingExtensionRequests.values()) pending.resolve({ cancelled: true });
            unsubscribe?.();
            unsubscribeBackpressure?.();
            unsubscribeExtensionRpc?.();
        }
        throw error;
    }
    if (!transport) registerSignalHandlers();`);
    next = once(next, `    let detachInput = () => { };
    async function shutdown(exitCode = 0, signal) {
        if (shuttingDown) {
            process.exit(exitCode);
        }`, `    let detachInput = () => { };
    let hostedClose;
    const closeHostedSession = () => hostedClose ??= (async () => {
        shuttingDown = true;
        for (const pending of pendingExtensionRequests.values()) pending.resolve({ cancelled: true });
        unsubscribe?.();
        unsubscribeBackpressure?.();
        unsubscribeExtensionRpc?.();
        let closeError;
        try {
            try { await session.abort(); }
            finally { await runtimeHost.dispose(); }
        } catch (error) {
            closeError = error;
            throw error;
        } finally {
            transport.onClose?.(closeError);
        }
    })();
    async function shutdown(exitCode = 0, signal) {
        if (transport) return closeHostedSession();
        if (shuttingDown) {
            process.exit(exitCode);
        }`);
    next = once(next, `    const onInputEnd = () => {`, `    if (transport) {
        return {
            dispatch: (command) => {
                if (shuttingDown) return Promise.reject(new Error("Hosted RPC session is closed"));
                return handleInputLine(JSON.stringify(command));
            },
            close: closeHostedSession,
            activatePresentation: () => rebindSession(true),
        };
    }
    const onInputEnd = () => {`);
    return next;
  },
  "dist/modes/rpc/rpc-mode.d.ts": patchDeclarations,
};
export const patches = Object.entries(transforms).map(([path, apply]) => ({
  id: path, packageName, version, path, preimageSha256: hashes[path], apply,
}));
export const files = [];
