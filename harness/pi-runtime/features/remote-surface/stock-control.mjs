import { conversationEntries, paginateConversation } from "./conversation-projection.mjs";
import { STOCK_UI_HOST } from "./stock-ui-host.mjs";

function tryCall(fn) {
  try { return fn(); }
  catch { return undefined; }
}

function contentFromInput(text, images) {
  if (!images?.length) return text;
  return [{ type: "text", text: String(text ?? "") }, ...images];
}

/** Stock AgentSession has no getInteractiveControl; bind one onto the extension host. */
export function attachStockInteractiveControl(pi, options = {}) {
  let ctx;
  let host;
  let port;
  let detached = false;
  const session = () => host?.session ?? options.session;
  const commands = () => host?.commandContext() ?? ctx;
  const previous = typeof pi.getInteractiveControl === "function" ? pi.getInteractiveControl.bind(pi) : undefined;
  const control = {
    async submitInput(text, submitOptions = {}) {
      const normalized = String(text ?? "").trim();
      if (!normalized && !(submitOptions.images?.length)) return { accepted: false, reason: "empty" };
      const delivery = submitOptions.delivery === "steer" ? "steer"
        : submitOptions.delivery === "followUp" ? "followUp" : undefined;
      const inputId = submitOptions.clientInputId;
      try {
        await pi.sendUserMessage(contentFromInput(normalized, submitOptions.images), {
          ...(delivery ? { deliverAs: delivery } : {}),
        });
      } catch (error) {
        return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const idle = tryCall(() => ctx?.isIdle?.()) ?? true;
      const disposition = idle ? "started" : delivery === "steer" ? "queued-steer" : delivery === "followUp" ? "queued-follow-up" : "started";
      return { accepted: true, ...(inputId ? { inputId } : {}), disposition };
    },
    abortAgent: async () => { ctx?.abort?.(); },
    executeUserBash: async (command, excluded) => {
      if (!host) throw new Error("User bash is unavailable without a TUI host");
      return host.executeUserBash(command, excluded);
    },
    abortUserBash: async () => host?.abortUserBash(),
    compact: async (instructions) => new Promise((resolve, reject) => {
      if (!ctx?.compact) return reject(new Error("compact is unavailable"));
      ctx.compact({ customInstructions: instructions, onComplete: resolve, onError: reject });
    }),
    navigateTree: async (targetEntryId, navigateOptions = {}) => {
      const command = commands();
      if (typeof command?.navigateTree !== "function") throw new Error("navigateTree is unavailable");
      const { instructions, ...rest } = navigateOptions;
      return command.navigateTree(targetEntryId, {
        ...rest,
        ...(instructions === undefined ? {} : { customInstructions: instructions }),
      });
    },
    fork: async (targetEntryId) => {
      const command = commands();
      if (typeof command?.fork !== "function") throw new Error("fork is unavailable");
      return command.fork(targetEntryId ?? ctx.sessionManager?.getLeafId?.(), { position: "at" });
    },
    newSession: async () => {
      const command = commands();
      if (typeof command?.newSession !== "function") throw new Error("newSession is unavailable");
      return command.newSession();
    },
    reload: async () => {
      const command = commands();
      if (typeof command?.reload !== "function") throw new Error("reload is unavailable");
      return command.reload();
    },
    shutdown: () => { ctx?.shutdown?.(); },
    setModel: async (provider, modelId) => {
      const model = ctx?.modelRegistry?.find?.(provider, modelId);
      if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
      await pi.setModel(model);
    },
    setThinkingLevel: (level) => pi.setThinkingLevel(level),
    setSessionName: (name) => pi.setSessionName(name),
    listCommands: () => {
      try {
        return (pi.getCommands?.() ?? []).map((command) => ({
          name: command.name,
          description: command.description,
          category: command.source === "extension" ? "extension" : "builtin",
          remoteMode: "direct",
        }));
      } catch {
        return [];
      }
    },
    snapshot: () => {
      const current = session();
      return {
        sessionFile: current?.sessionFile ?? tryCall(() => ctx?.sessionManager?.getSessionFile?.()),
        sessionName: tryCall(() => pi.getSessionName?.()) ?? ctx?.sessionManager?.getSessionName?.(),
        leafEntryId: ctx?.sessionManager?.getLeafId?.(),
        model: ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name } : undefined,
        thinkingLevel: ctx?.thinkingLevel ?? pi.getThinkingLevel?.(),
        isStreaming: !(tryCall(() => ctx?.isIdle?.()) ?? true),
        isCompacting: Boolean(current?.isCompacting),
        pendingMessageCount: current?.pendingMessageCount !== undefined ? current.pendingMessageCount
          : tryCall(() => ctx?.hasPendingMessages?.()) ? 1 : 0,
        contextUsage: tryCall(() => ctx?.getContextUsage?.()),
        uiRequest: host?.uiRequest,
        requestTimeline: current?.requestTimelineSnapshot?.() ?? { schemaVersion: 1, runs: [], pendingInputs: [], hasOlder: false },
      };
    },
    clearPendingInputs: () => session()?.clearPendingInteractiveInputs?.() ?? { clearedIds: [] },
    readConversationPage: (input = {}) => {
      const current = session();
      if (typeof current?.readConversationPage === "function") return current.readConversationPage(input);
      const entries = conversationEntries(ctx?.sessionManager?.getBranch?.() ?? [], options.protocol, { limit: Number.MAX_SAFE_INTEGER });
      const page = paginateConversation(entries, input);
      if (page.error) throw Object.assign(new Error(page.message), { code: page.error });
      return {
        entries: page.entries,
        requestRuns: current?.requestTimelineSnapshot?.()?.runs ?? [],
        ...(page.nextBefore === undefined ? {} : { nextBefore: page.nextBefore }),
      };
    },
    respondToUiRequest: (id, value) => host?.respond(id, value) ?? false,
  };
  const bind = (_event, nextCtx) => {
    const nextPort = nextCtx.ui?.[STOCK_UI_HOST];
    if (port && nextPort === port) return;
    ctx = nextCtx;
    detached = false;
    port = nextPort;
    host = port?.activate((name, data) => pi.events.emit(name, data));
    port?.onDispose(() => {
      if (port !== nextPort) return;
      host = undefined; ctx = undefined; port = undefined;
      detached = true;
    });
  };
  pi.on("session_start", bind);
  pi.on("rubato.presentation.bind", bind);
  const scoped = Object.fromEntries(Object.entries(control).map(([key, fn]) => {
    const invoke = (...args) => {
      if (detached || (options.hosted && !port)) throw new Error('Remote control belongs to a stale terminal presentation');
      return port ? port.run(() => fn(...args)) : fn(...args);
    };
    // Keep each public method's original sync/Promise contract on stale ports.
    return [key, fn.constructor.name === 'AsyncFunction' ? async (...args) => invoke(...args) : invoke];
  }));
  pi.getInteractiveControl = () => previous?.() ?? scoped;
  return control;
}
