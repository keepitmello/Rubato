import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { historyNotesEnabled } from "../context-notes/config.mjs";
import { ContextNotesController, GUIDANCE } from "../context-notes/controller.mjs";
import { createContextNotesTools } from "../context-notes/tools.mjs";

const installed = new WeakMap();

async function loadTypebox() {
  const { senpiPackageJson } = await import("../engine-paths.mjs");
  const require = createRequire(senpiPackageJson);
  const module = await import(pathToFileURL(require.resolve("typebox")).href);
  if (!module.Type) throw new Error("설치된 엔진의 TypeBox 인터페이스가 달라졌어요.");
  return module.Type;
}

export async function installContextNotes(pi, options = {}) {
  if (!(options.enabled ?? historyNotesEnabled())) return undefined;
  if (installed.has(pi)) return installed.get(pi);
  let controller;
  const getController = (ctx) => {
    const id = ctx.sessionManager.getSessionId();
    if (controller?.sessionId !== id) {
      controller?.close();
      controller = undefined;
      controller = new ContextNotesController(pi, ctx, options);
    } else controller.refresh(ctx);
    return controller;
  };
  const report = (error, ctx, fatal = false) => {
    if (controller) controller.fail(error, fatal);
    else {
      ctx.ui?.notify?.(error?.message ?? String(error), "error");
      ctx.abort?.("system");
    }
  };
  const api = { getController, close: () => { controller?.close(); controller = undefined; } };
  // Mark installed only after tools/schema loading succeeds. The engine's
  // admission gate refuses provider requests if initialization ever fails.
  const Type = options.Type ?? await loadTypebox();
  for (const tool of createContextNotesTools(getController, Type)) pi.registerTool(tool);
  pi.on("session_start", async (_event, ctx) => {
    try { getController(ctx).showStatus(); } catch (error) { report(error, ctx, true); throw error; }
  });
  pi.on("session_shutdown", async () => api.close());
  pi.on("session_abort", async () => { if (controller) controller.pending = null; });
  pi.on("agent_end", async (event) => { if (controller && event.aborted) controller.pending = null; });
  pi.on("session_before_tree", async (event, ctx) => {
    if (event.preparation?.userWantsSummary) {
      ctx.ui?.notify?.("작업 노트 모드에서는 가지 요약을 만들지 않아요. 요약 없이 이동해 주세요.", "warning");
      return { cancel: true };
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    try { const c = getController(ctx); c.pending = null; c.refresh(ctx, true); c.showStatus(); }
    catch (error) { report(error, ctx, true); }
  });
  pi.on("model_select", async (_event, ctx) => {
    try { getController(ctx).showStatus(); } catch (error) { report(error, ctx); }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      getController(ctx).admit();
      const base = event.systemPrompt ?? ctx.getSystemPrompt?.() ?? "";
      return { systemPrompt: base.includes(GUIDANCE) ? base : `${base}\n\n${GUIDANCE}` };
    } catch (error) { report(error, ctx); throw error; }
  });
  pi.on("context", async (event, ctx) => {
    try { return getController(ctx).prepareContext(event, ctx); }
    catch (error) { report(error, ctx); throw error; }
  });
  pi.on("turn_end", async (event, ctx) => {
    try { await getController(ctx).turnEnd(event, ctx); }
    catch (error) { report(error, ctx, true); }
  });
  // Blocks manual/automatic summaries that enter the extension lifecycle.
  // Speculative, idle and pruning paths are stopped by the engine transforms.
  pi.on("session_before_compact", async () => ({ cancel: true, rejectionCause: "external-owner",
    reason: "작업 노트 모드에서는 요약 압축을 실행하지 않아요. /new-context를 사용해 주세요." }));
  pi.registerCommand("new-context", {
    description: "작업 노트를 저장하고 요약 없이 새 문맥 창으로 넘어가요",
    async handler(_args, ctx) {
      try { await getController(ctx).manual(ctx); }
      catch (error) { report(error, ctx); }
    },
  });
  pi.registerCommand("context-status", {
    description: "현재 문맥 창과 노트, 실험 한도를 확인해요",
    async handler(_args, ctx) {
      try {
        const c = getController(ctx);
        const usage = c.usage();
        ctx.ui?.notify?.(`문맥 ${c.window.number + 1} · 약 ${usage.tokens}/${usage.target}토큰 · 노트 ${c.store.noteVersions.size}개\n${c.fatal ?? c.paused ?? "사용할 수 있어요."}`, c.fatal || c.paused ? "warning" : "info");
      } catch (error) { report(error, ctx); }
    },
  });
  installed.set(pi, api);
  return api;
}
