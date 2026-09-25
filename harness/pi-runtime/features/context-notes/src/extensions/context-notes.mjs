import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  HISTORY_NOTES_MODE, SUMMARY_MODE, contextMode, historyNotesEnabled,
  isUserExplicitContextMode, setContextMode,
} from "../context-notes/config.mjs";
import { ContextNotesController, guidanceFor } from "../context-notes/controller.mjs";
import { assertEngineParts } from "../context-notes/engine-gate.mjs";
import {
  NOTES_RESUME_IN_SUMMARY,
  SUMMARY_SESSION_COMMAND_NOTICE,
  adoptContextMode,
  branchFromLeaf,
  considerContextModeSwitch,
  hasNotesWindowBoundary,
  hasNotesWindowEntries,
  recordedModeFromBranch,
} from "../context-notes/mode-policy.mjs";
import { MODE_ENTRY } from "../context-notes/protocol.mjs";
import { createContextNotesTools, syncNotesToolActivation } from "../context-notes/tools.mjs";

const installed = new WeakMap();

async function loadTypebox() {
  const { senpiPackageJson } = await import("../engine-paths.mjs");
  const require = createRequire(senpiPackageJson);
  const module = await import(pathToFileURL(require.resolve("typebox")).href);
  if (!module.Type) throw new Error("설치된 엔진의 TypeBox 인터페이스가 달라졌어요.");
  return module.Type;
}

function sessionBranch(ctx) {
  const manager = ctx?.sessionManager;
  if (typeof manager?.getBranch === "function") return manager.getBranch();
  return manager?.getEntries?.() ?? [];
}

export async function installContextNotes(pi, options = {}) {
  if (installed.has(pi)) return installed.get(pi);
  const liveSwitch = options.enabled == null;
  const liveEnv = options.env ?? process.env;
  const propagateEnv = options.propagateEnv ?? true;
  const settingsManager = options.settingsManager;
  let liveMode = options.enabled == null
    ? contextMode(liveEnv)
    : (options.enabled ? HISTORY_NOTES_MODE : SUMMARY_MODE);
  const notesActive = () => options.enabled ?? (liveMode === HISTORY_NOTES_MODE);
  const bindMode = (mode, ctx) => {
    liveMode = setContextMode(mode, liveEnv, {
      sessionId: ctx?.sessionManager?.getSessionId?.(),
      settingsManager,
      propagateEnv,
    });
    return liveMode;
  };
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
  const declinedPairs = new Set();
  const persistMode = (mode) => {
    pi.appendEntry?.(MODE_ENTRY, { mode });
  };
  const api = { getController, close: () => { controller?.close(); controller = undefined; } };
  // Mark installed only after tools/schema loading succeeds. The engine's
  // admission gate refuses provider requests if initialization ever fails.
  const Type = options.Type ?? await loadTypebox();
  const toolDefinitions = createContextNotesTools(getController, Type, notesActive);
  for (const tool of toolDefinitions) pi.registerTool(tool);
  const syncTools = (enabled) => syncNotesToolActivation(pi, enabled, toolDefinitions);
  const applyResolvedMode = (ctx, { persistIfMissing = false, allowModelDefault = true } = {}) => {
    const branch = sessionBranch(ctx);
    if (liveSwitch) {
      const userExplicit = isUserExplicitContextMode(liveEnv);
      if (userExplicit) {
        bindMode(contextMode(liveEnv), ctx);
        if (liveMode === SUMMARY_MODE && hasNotesWindowEntries(branch)) {
          throw new Error(NOTES_RESUME_IN_SUMMARY);
        }
      } else {
        const mode = adoptContextMode({ env: liveEnv, branch, model: ctx.model, allowModelDefault });
        if (mode === HISTORY_NOTES_MODE && options.requireEngine !== false) assertEngineParts();
        if (mode === SUMMARY_MODE && hasNotesWindowBoundary(branch)) {
          throw new Error(NOTES_RESUME_IN_SUMMARY);
        }
        bindMode(mode, ctx);
      }
      // Only persist a mode the session already committed to. Snapshot
      // userExplicit before bindMode: setContextMode marks ORIGIN=session
      // and would otherwise make the same check look inherited. A brand-new
      // session_start often has no model (T3 set_model comes later); writing
      // the no-model summary fallback would then force a blocking confirm.
      if (
        persistIfMissing
        && !recordedModeFromBranch(branch)
        && (userExplicit || hasNotesWindowEntries(branch))
      ) persistMode(liveMode);
    }
    syncTools(notesActive());
    if (notesActive()) getController(ctx).showStatus();
    else api.close();
  };
  pi.on("session_start", async (_event, ctx) => {
    try { applyResolvedMode(ctx, { persistIfMissing: true }); }
    catch (error) { report(error, ctx, true); throw error; }
  });
  pi.on("session_shutdown", async () => api.close());
  pi.on("session_abort", async () => {
    if (controller) { controller.pending = null; controller.checkpointRequested = false; }
  });
  pi.on("agent_end", async (event) => {
    if (controller && event.aborted) controller.pending = null;
  });
  pi.on("session_before_tree", async (event, ctx) => {
    const targetId = event.preparation?.targetId;
    if (targetId && liveSwitch && !isUserExplicitContextMode(liveEnv)) {
      const dest = branchFromLeaf(ctx.sessionManager?.getEntries?.() ?? [], targetId);
      const destMode = adoptContextMode({ env: liveEnv, branch: dest, model: ctx.model, allowModelDefault: false });
      if (destMode === SUMMARY_MODE && hasNotesWindowBoundary(dest)) {
        ctx.ui?.notify?.(NOTES_RESUME_IN_SUMMARY, "warning");
        return { cancel: true };
      }
    }
    if (notesActive() && event.preparation?.userWantsSummary) {
      ctx.ui?.notify?.("작업 노트 모드에서는 가지 요약을 만들지 않아요. 요약 없이 이동해 주세요.", "warning");
      return { cancel: true };
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    try {
      applyResolvedMode(ctx, { allowModelDefault: false });
      if (notesActive() && controller) { controller.pending = null; controller.refresh(ctx, true); controller.showStatus(); }
    } catch (error) { report(error, ctx, true); }
  });
  pi.on("model_select", async (event, ctx) => {
    try {
      if (liveSwitch) {
        const decision = await considerContextModeSwitch({
          model: event.model,
          source: event.source,
          currentMode: liveMode,
          branch: sessionBranch(ctx),
          confirm: ctx.ui?.confirm?.bind(ctx.ui),
          notify: ctx.ui?.notify?.bind(ctx.ui),
          declined: declinedPairs,
        });
        if (decision.action === "switch") {
          bindMode(decision.mode, ctx);
          persistMode(decision.mode);
          syncTools(decision.mode === HISTORY_NOTES_MODE);
          if (decision.mode !== HISTORY_NOTES_MODE) {
            api.close();
            ctx.ui?.setStatus?.("rubato-context-notes", undefined);
          }
        }
      }
      if (notesActive()) getController(ctx).showStatus();
      else syncTools(false);
    } catch (error) { report(error, ctx); }
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!notesActive()) return;
    try { getController(ctx).admit(); }
    catch (error) { report(error, ctx); throw error; }
  });
  pi.on("system_prompt", async (event, ctx) => {
    if (!notesActive()) return;
    const base = event.systemPrompt ?? ctx.getSystemPrompt?.() ?? "";
    // The text follows the model's context strategy (Astra's is unchanged); it is a pure
    // function of the model, so every request of a session sees the same prompt.
    const guidance = guidanceFor(ctx.model);
    return { systemPrompt: base.includes(guidance) ? base : `${base}\n\n${guidance}` };
  });
  pi.on("context", async (event, ctx) => {
    if (!notesActive()) return;
    try { return getController(ctx).prepareContext(event, ctx); }
    catch (error) { report(error, ctx); throw error; }
  });
  pi.on("turn_end", async (event, ctx) => {
    if (!notesActive()) return;
    try { await getController(ctx).turnEnd(event, ctx); }
    catch (error) { report(error, ctx, true); }
  });
  // Blocks manual/automatic summaries that enter the extension lifecycle.
  // Speculative, idle and pruning paths are stopped by the engine transforms.
  pi.on("session_before_compact", async () => {
    if (!notesActive()) return;
    return { cancel: true, rejectionCause: "external-owner",
      reason: "작업 노트 모드에서는 요약 압축을 실행하지 않아요. /new-context를 사용해 주세요." };
  });
  // T3의 컴팩션 컨트롤과 앱에서 친 /compact 는 이 명령으로 들어온다. 정리 방식이
  // 모드마다 다르므로 분기는 여기서 한다 — 부르는 쪽은 모드를 모른 채 이름만 본다.
  //
  // 노트 모드의 컷을 session_before_compact 훅 안에서 돌릴 수는 없다: 엔진의
  // compact() 가 훅을 부르기 전에 _compactionAbortController 를 세우고, 그 구간에는
  // applyCompaction 이 isCompacting 으로 거부한다. 그래서 훅은 계속 거부만 하고,
  // 컷은 이 명령이 훅 바깥에서 돈다.
  pi.registerCommand("compact", {
    description: "지금 문맥을 정리해요. 작업 노트 모드에서는 노트를 저장하고 새 문맥 창으로 넘어가요",
    async handler(args, ctx) {
      const customInstructions = typeof args === "string" ? args.trim() : "";
      if (!notesActive()) {
        ctx.compact?.(customInstructions ? { customInstructions } : undefined);
        return;
      }
      try { await getController(ctx).manual(ctx); }
      catch (error) { report(error, ctx); }
    },
  });
  pi.registerCommand("new-context", {
    description: "작업 노트를 저장하고 요약 없이 새 문맥 창으로 넘어가요",
    async handler(_args, ctx) {
      if (!notesActive()) {
        ctx.ui?.notify?.(SUMMARY_SESSION_COMMAND_NOTICE, "warning");
        return;
      }
      try { await getController(ctx).manual(ctx); }
      catch (error) { report(error, ctx); }
    },
  });
  pi.registerCommand("context-status", {
    description: "현재 문맥 창과 노트, 실험 한도를 확인해요",
    async handler(_args, ctx) {
      if (!notesActive()) {
        ctx.ui?.notify?.(SUMMARY_SESSION_COMMAND_NOTICE, "warning");
        return;
      }
      try {
        const c = getController(ctx);
        const usage = c.usage();
        const line = usage.target ?? usage.safetyLine ?? usage.full;
        ctx.ui?.notify?.(`문맥 ${c.window.number + 1} · 약 ${usage.tokens}/${line}토큰 · ${usage.strategy} · 노트 ${c.store.noteVersions.size}개\n${c.fatal ?? c.paused ?? "사용할 수 있어요."}`, c.fatal || c.paused ? "warning" : "info");
      } catch (error) { report(error, ctx); }
    },
  });
  installed.set(pi, api);
  return api;
}
