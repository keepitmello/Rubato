import { conversationEntries, paginateConversation } from "./conversation-projection.mjs";

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
    executeUserBash: async () => { throw new Error("User bash is unavailable without a TUI host"); },
    abortUserBash: async () => undefined,
    compact: (instructions) => new Promise((resolve, reject) => {
      if (!ctx?.compact) return reject(new Error("compact is unavailable"));
      ctx.compact({ customInstructions: instructions, onComplete: resolve, onError: reject });
    }),
    navigateTree: async (targetEntryId, navigateOptions = {}) => {
      if (typeof ctx?.navigateTree !== "function") throw new Error("navigateTree is unavailable");
      const { instructions, ...rest } = navigateOptions;
      await ctx.navigateTree(targetEntryId, {
        ...rest,
        ...(instructions === undefined ? {} : { customInstructions: instructions }),
      });
    },
    fork: async (targetEntryId) => {
      if (typeof ctx?.fork !== "function") throw new Error("fork is unavailable");
      await ctx.fork(targetEntryId ?? ctx.sessionManager?.getLeafId?.(), { position: "at" });
    },
    newSession: async () => {
      if (typeof ctx?.newSession !== "function") throw new Error("newSession is unavailable");
      await ctx.newSession();
    },
    reload: async () => {
      if (typeof ctx?.reload !== "function") throw new Error("reload is unavailable");
      await ctx.reload();
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
      const session = options.session;
      return {
        sessionFile: session?.sessionFile,
        sessionName: tryCall(() => pi.getSessionName?.()) ?? ctx?.sessionManager?.getSessionName?.(),
        leafEntryId: ctx?.sessionManager?.getLeafId?.(),
        model: ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name } : undefined,
        thinkingLevel: ctx?.thinkingLevel ?? pi.getThinkingLevel?.(),
        isStreaming: !(tryCall(() => ctx?.isIdle?.()) ?? true),
        isCompacting: Boolean(session?.isCompacting),
        pendingMessageCount: tryCall(() => ctx?.hasPendingMessages?.()) ? 1 : 0,
        contextUsage: tryCall(() => ctx?.getContextUsage?.()),
        uiRequest: undefined,
        requestTimeline: session?.requestTimelineSnapshot?.() ?? { schemaVersion: 1, runs: [], pendingInputs: [], hasOlder: false },
      };
    },
    clearPendingInputs: () => options.session?.clearPendingInteractiveInputs?.() ?? { clearedIds: [] },
    readConversationPage: (input = {}) => {
      if (typeof options.session?.readConversationPage === "function") return options.session.readConversationPage(input);
      const entries = conversationEntries(ctx?.sessionManager?.getBranch?.() ?? [], options.protocol, { limit: Number.MAX_SAFE_INTEGER });
      const page = paginateConversation(entries, input);
      if (page.error) throw Object.assign(new Error(page.message), { code: page.error });
      return {
        entries: page.entries,
        requestRuns: options.session?.requestTimelineSnapshot?.()?.runs ?? [],
        ...(page.nextBefore === undefined ? {} : { nextBefore: page.nextBefore }),
      };
    },
    respondToUiRequest: () => false,
  };
  pi.on("session_start", (_event, nextCtx) => { ctx = nextCtx; });
  pi.getInteractiveControl = () => previous?.() ?? control;
  return control;
}
