export const EXTENSION_RPC_CHANNEL = "rubato.extension-rpc.event";

function rpcName(name) {
  if (typeof name !== "string" || name.trim() === "") throw new Error("Extension RPC name must not be empty");
  return name.trim();
}

/** Registry ownership follows the stock extension and its runtime lifetime. */
export function createExtensionRpc(extension, assertActive, eventBus) {
  return {
    emit(name, data) {
      assertActive();
      eventBus.emit(EXTENSION_RPC_CHANNEL, { name: rpcName(name), data });
    },
    handle(name, handler) {
      assertActive();
      const normalized = rpcName(name);
      if (typeof handler !== "function") throw new TypeError("Extension RPC handler must be a function");
      const handlers = extension.rpcHandlers ??= new Map();
      if (handlers.has(normalized)) throw new Error(`RPC extension request handler already registered: ${normalized}`);
      handlers.set(normalized, handler);
    },
  };
}

export async function requestExtensionRpc(extensions, assertActive, name, data) {
  assertActive();
  const normalized = rpcName(name);
  const handlers = extensions.flatMap((extension) => {
    const handler = extension.rpcHandlers?.get(normalized);
    return handler ? [handler] : [];
  });
  if (!handlers.length) throw new Error(`Unknown extension RPC request: ${normalized}`);
  if (handlers.length > 1) throw new Error(`Multiple extension RPC request handlers registered: ${normalized}`);
  const result = await handlers[0](data);
  assertActive(); // An answer from an unloaded runtime is not a current result.
  return result;
}
