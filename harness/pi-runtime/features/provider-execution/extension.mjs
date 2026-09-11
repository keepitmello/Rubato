import { createCursorExecBridge } from "./cursor-exec-bridge.mjs";

export { createCursorExecJournal, cursorExecJournalPath } from "./cursor-exec-journal.mjs";
export { resetCursorExecBridgeState } from "./cursor-exec-bridge.mjs";

async function loadStagedCursorProvider(options) {
  const module = await import("../providers/src/cursor-route.mjs");
  return module.cursorDirectProvider(options);
}

function wrapStream(source) {
  if (typeof source !== "function") return source;
  return function cursorExecutionStream(model, context, options = {}) {
    const onToolResult = async (result) => {
      const replacement = await options.onToolResult?.(result);
      return replacement ?? result;
    };
    const execHandlers = options.execHandlers ?? (() => {
      if (typeof options.providerExecuteTool !== "function") {
        throw new Error("provider-execution requires a request-local session tool executor");
      }
      return createCursorExecBridge({
        executeTool: options.providerExecuteTool,
        signal: options.signal,
        cwd: options.providerExecCwd,
        agentDir: options.providerExecAgentDir,
        getLineageId: options.providerExecLineageId,
        onStart: options.onProviderToolExecutionStart,
        onUpdate: options.onProviderToolExecutionUpdate,
        onEnd: options.onProviderToolExecutionEnd,
      });
    })();
    return source.call(this, model, context, {
      ...options,
      execHandlers,
      onToolResult,
    });
  };
}

function wrapCursorProvider(provider) {
  const top = {
    ...(typeof provider.stream === "function"
      ? { stream: wrapStream(provider.stream) }
      : {}),
    ...(typeof provider.streamSimple === "function"
      ? { streamSimple: wrapStream(provider.streamSimple) }
      : {}),
  };
  const api = provider.api
    ? {
        ...provider.api,
        ...(typeof provider.api.stream === "function"
          ? { stream: wrapStream(provider.api.stream) }
          : {}),
        ...(typeof provider.api.streamSimple === "function"
          ? { streamSimple: wrapStream(provider.api.streamSimple) }
          : {}),
      }
    : undefined;
  return { ...provider, ...top, ...(api ? { api } : {}) };
}

/**
 * One controller must be shared by the providers factory and this extension
 * factory. The provider can be built before ExtensionAPI is bound; a request
 * cannot execute until the matching session has installed the extension.
 */
export function createProviderExecution({ cursorProviderFactory = loadStagedCursorProvider } = {}) {
  if (typeof cursorProviderFactory !== "function") {
    throw new TypeError("provider-execution requires a cursor provider factory");
  }
  const bindings = new Set();
  let generation = 0;

  const extension = (pi) => {
    if (typeof pi?.executeTool !== "function") {
      throw new Error("provider-execution requires the tool-execution feature");
    }
    const current = ++generation;
    bindings.add(current);
    pi.on("session_shutdown", () => {
      bindings.delete(current);
    });
  };

  const cursorRouteFactory = async (options = {}) =>
    wrapCursorProvider(await cursorProviderFactory(options));

  return Object.freeze({
    extension,
    cursorRouteFactory,
    getState: () => Object.freeze({ bound: bindings.size > 0, generation }),
  });
}
