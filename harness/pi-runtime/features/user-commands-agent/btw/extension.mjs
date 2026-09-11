import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { buildSideQueryContext, getSideQueryPromptContextWindow, runSideQuery } from "./side-query.mjs";

function resolveStreamFn(ctx) {
  const runtime = ctx.modelRegistry?.runtime;
  if (typeof runtime?.streamSimple === "function") return runtime.streamSimple.bind(runtime);
  if (typeof ctx.modelRegistry?.complete === "function") {
    return async (model, context, options) => {
      const message = await ctx.modelRegistry.complete(model, context, options);
      return (async function* () {
        const text = Array.isArray(message?.content)
          ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
          : String(message?.content ?? "");
        if (text) yield { type: "text_delta", delta: text };
        yield { type: "done", message };
      })();
    };
  }
  return undefined;
}

export function createBtwExtension() {
  return (pi) => {
    let active;
    function dismiss(ctx, options) {
      const current = active;
      if (!current) return;
      active = undefined;
      if (options.abort) current.controller.abort();
    }
    pi.on("session_before_switch", (_event, ctx) => dismiss(ctx, { abort: true }));
    pi.on("session_before_fork", (_event, ctx) => dismiss(ctx, { abort: true }));
    pi.on("session_shutdown", (_event, ctx) => dismiss(ctx, { abort: true }));
    pi.on("input", (_event, ctx) => { if (active?.settled) dismiss(ctx, { abort: false }); });
    pi.registerCommand("btw", {
      description: "Ask a side question in parallel without touching the main session",
      argumentHint: "<question>",
      handler: async (args, ctx) => {
        const question = args.trim();
        if (!question) {
          ctx.ui.notify("Usage: /btw <question>", "warning");
          return;
        }
        const model = ctx.model;
        if (!model) {
          ctx.ui.notify("No active model available for /btw.", "error");
          return;
        }
        const snapshot = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
        const history = convertToLlm(snapshot.messages);
        const systemPrompt = ctx.getSystemPrompt();
        const thinkingLevel = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : ctx.thinkingLevel;
        const sessionId = ctx.sessionManager.getSessionId();
        dismiss(ctx, { abort: true });
        const controller = new AbortController();
        const entry = { controller, settled: false };
        active = entry;
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          if (active !== entry) return;
          dismiss(ctx, { abort: false });
          ctx.ui.notify("/btw: " + auth.error, "error");
          return;
        }
        try {
          const context = buildSideQueryContext({
            systemPrompt,
            history,
            question,
            promptContextWindow: getSideQueryPromptContextWindow(model),
          });
          const { replyText } = await runSideQuery({
            model,
            auth: { apiKey: auth.apiKey, headers: auth.headers, extraBody: auth.extraBody },
            sessionId,
            thinkingLevel: thinkingLevel === "off" ? undefined : thinkingLevel,
            streamFn: resolveStreamFn(ctx),
          }, context, { signal: controller.signal });
          if (active !== entry) return;
          entry.settled = true;
          ctx.ui.notify(replyText || "(empty /btw reply)", "info");
        } catch (error) {
          if (active !== entry) return;
          entry.settled = true;
          if (controller.signal.aborted) return;
          ctx.ui.notify("/btw failed: " + (error instanceof Error ? error.message : String(error)), "error");
        }
      },
    });
  };
}

export default createBtwExtension;
