import { pathToFileURL } from "node:url";
import { runOrDeferExtension } from "../deferred-extensions.mjs";
import { senpiExtensionRunner } from "../engine-paths.mjs";
import {
  cacheStatus,
  formatBackgroundLine,
  formatCacheSegment,
  formatContext,
  formatFooterMetrics,
  formatModelWithEffort,
  layoutStatusLines,
  remainingPercent,
  resolveCachePolicy,
  repoBasename,
  sessionCacheHitPercent,
  truncateToWidth,
} from "../statusline.mjs";
import { BRAND_NAME } from "../brand.mjs";
import {
  createBackgroundTracker,
  WAKE_SOURCE_STATE_EVENT,
} from "../background-tracker.mjs";
import { PROCESS_STARTED_AT } from "../process-start.mjs";
import { speedIndexStore } from "../speed-index-store.mjs";

/**
 * `mem:<identity> …` 은 회고 백로그를 세는 줄이라 늘 떠 있다. 정보가 아니라 소음이므로
 * footer 에서 뺀다.
 */
const HIDDEN_STATUS_KEYS = new Set(["memory"]);

/** 시계를 초 단위로 보여주므로 1초. 도는 게 없으면 타이머 자체를 세우지 않는다. */
const TICK_MS = 1_000;
const MUTED_RED = "\x1b[38;2;196;116;110m";
const RESET = "\x1b[0m";

/** Senpi 내장 footer 가 이 키로 등록된 painter 를 찾는다. 모듈 경로가 달라도 같은 슬롯이다. */
export const RUBATO_FOOTER_HOST = Symbol.for("rubato.pi.footer");

function remainingColor(remaining) {
  if (remaining == null) return "dim";
  if (remaining > 70) return "success";
  if (remaining > 40) return "warning";
  return "error";
}

function bindSpeedStore(speedStore) {
  return {
    clearIdentity() {
      speedStore?.clearActiveIdentity?.();
    },
    /** Session start/switch drops every live sample; a new session scores from zero. */
    resetSession() {
      if (typeof speedStore?.resetSession === "function") speedStore.resetSession();
      else speedStore?.clearActiveIdentity?.();
    },
    refresh() {
      speedStore?.refresh?.();
    },
    startProbes() {
      speedStore?.startProbes?.();
    },
    cachedText() {
      return formatFooterMetrics({ speed: speedStore?.getCachedScore?.() });
    },
  };
}

/**
 * Senpi 기본 footer 는 `~/path • main • $0.000 (sub) • 2/500K (0.0%) (auto)` 다.
 * `setFooter` 가 없거나 no-op UI 에 심으면 그 줄이 그대로 남는다.
 */
export function canSetFooter(ctx) {
  if (typeof ctx?.ui?.setFooter !== "function") return false;
  if (ctx.hasUI === false) return false;
  return true;
}

export function registerFooterHost(host) {
  globalThis[RUBATO_FOOTER_HOST] = host;
  return host;
}

export function footerHost() {
  return globalThis[RUBATO_FOOTER_HOST];
}

/** Host 가 없거나 paint 가 비어도 senpi cwd/cost 줄로 떨어지지 않게 하는 최소 줄. */
export function fallbackStatusLines(component, width) {
  try {
    const lines = paintStatusLines({
      ctx: ctxFromHostSession(component?.session),
      theme: component?.theme,
      footerData: component?.footerData,
      width,
      speedText: "Speed —",
    });
    if (Array.isArray(lines) && lines.length > 0) return lines;
  } catch {
    // Session inspection is best-effort. The caller still needs a Rubato line.
  }
  return ["✦ — · Speed —"];
}

/** InteractiveMode / FooterComponent 가 쥐고 있는 session 으로 상태줄 ctx 를 만든다. */
export function ctxFromHostSession(session, ui) {
  if (!session) return undefined;
  return {
    get cwd() {
      return session.sessionManager?.getCwd?.() ?? "";
    },
    get model() {
      return session.model;
    },
    get thinkingLevel() {
      return session.thinkingLevel;
    },
    get serviceTier() {
      return session.effectiveServiceTier ?? session.serviceTier;
    },
    isFastModeActive() {
      return session.isFastModeActive?.() === true;
    },
    getThinkingLevel() {
      return session.getThinkingLevel?.() ?? session.thinkingLevel;
    },
    get modelRegistry() {
      return session.modelRegistry;
    },
    get sessionManager() {
      return session.sessionManager;
    },
    getContextUsage() {
      return session.getContextUsage?.();
    },
    ui,
    hasUI: ui != null,
  };
}

export function paintStatusLines({
  ctx,
  theme,
  footerData,
  width,
  speedText,
  backgroundGroups,
  nowMs = Date.now(),
} = {}) {
  if (!ctx) return undefined;
  const usage = ctx.getContextUsage?.();
  const remaining = remainingPercent(usage?.percent);
  const window = usage?.contextWindow ?? ctx.model?.contextWindow;
  const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
  const cachePolicy = resolveCachePolicy(ctx.model);
  const cacheLifetime = cacheStatus(branchEntries, cachePolicy, nowMs);
  const cache = sessionCacheHitPercent(branchEntries);
  const cacheText = formatCacheSegment(cache, cacheLifetime);
  const paint = (parts) => parts
    .map((part) => (theme?.fg ? theme.fg(part.color, part.text) : part.text))
    .join(" · ");
  const identity = [
    {
      text: `✦ ${formatModelWithEffort(ctx.model?.id, ctx.thinkingLevel ?? ctx.getThinkingLevel?.(), ctx.model, ctx.modelRegistry?.getAll?.(), ctx.isFastModeActive?.() === true || ctx.serviceTier === "priority")}`,
      color: "accent",
    },
    { text: formatContext(remaining, window), color: remainingColor(remaining) },
  ];
  if (cacheText) {
    identity.push({
      text: cacheLifetime?.expired
        ? `${MUTED_RED}${cacheText}${RESET}`
        : cacheText,
      color: "dim",
    });
  }
  const branch = footerData?.getGitBranch?.();
  if (branch) identity.push({ text: branch, color: "dim" });
  const repo = repoBasename(ctx.cwd);
  if (repo) identity.push({ text: repo, color: "text" });
  const metrics = [{ text: speedText ?? "Speed —", color: "dim" }];
  const mark = theme?.fg ? theme.fg("dim", BRAND_NAME) : BRAND_NAME;
  const lines = layoutStatusLines(paint(identity), paint(metrics), width, mark);
  const background = formatBackgroundLine(backgroundGroups, nowMs, width);
  if (background) {
    lines.push(truncateToWidth(theme?.fg ? theme.fg("dim", background) : background, width));
  }
  const statusLine = extensionStatusLine(footerData?.getExtensionStatuses?.());
  if (statusLine) lines.push(truncateToWidth(statusLine, width));
  return lines;
}

let hookedRunner;
let hookedApply;

/**
 * `session_start` 핸들러는 builtin(특히 MCP attach) 뒤에서 await 된다.
 * UI 가 runner 에 붙는 순간 — emit 전 — 커스텀 footer 를 심어야 기본 줄이 보이지 않는다.
 * `resetExtensionUI()` 도 다시 `setUIContext` 를 타므로 세션 전환 뒤에도 같은 경로로 복구된다.
 */
export function hookExtensionRunnerFooter(ExtensionRunner, applyFooter) {
  if (!ExtensionRunner?.prototype || typeof applyFooter !== "function") return false;
  hookedApply = applyFooter;
  if (hookedRunner === ExtensionRunner) return true;
  const original = ExtensionRunner.prototype.setUIContext;
  if (typeof original !== "function") return false;
  ExtensionRunner.prototype.setUIContext = function setUIContext(uiContext, mode) {
    const result = original.call(this, uiContext, mode);
    if (typeof hookedApply !== "function") return result;
    const hasUI = typeof this.hasUI === "function" ? this.hasUI() : Boolean(uiContext);
    if (!hasUI) return result;
    try {
      const ctx = typeof this.createContext === "function"
        ? this.createContext()
        : { ui: uiContext, hasUI: true };
      hookedApply(ctx);
    } catch {
      // Host context is best-effort; session_start / before_agent_start still apply.
    }
    return result;
  };
  hookedRunner = ExtensionRunner;
  return true;
}

export function installStatusline(pi, { processStartedAt = PROCESS_STARTED_AT, speedStore = speedIndexStore() } = {}) {
  void processStartedAt;
  const speed = bindSpeedStore(speedStore);
  const tracker = createBackgroundTracker();
  let latestCtx;

  speed.startProbes();

  function linesFor(ctx, theme, footerData, width, nowMs) {
    return paintStatusLines({
      ctx,
      theme,
      footerData,
      width,
      speedText: speed.cachedText(),
      backgroundGroups: tracker.groups(),
      nowMs,
    });
  }

  function applyFooter(ctx) {
    if (!canSetFooter(ctx)) return false;
    latestCtx = ctx;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const rerender = () => tui.requestRender?.();
      const unsubBranch = footerData.onBranchChange?.(rerender);

      // 배경 상태는 이벤트로 온다. 시계를 흐르게 하려면 그 위에 초당 tick 이 하나 더 필요하다.
      const onWakeSource = (event) => {
        if (tracker.accept(event)) rerender();
      };
      pi.events?.on?.(WAKE_SOURCE_STATE_EVENT, onWakeSource);

      let timer;
      let cacheClockActive = false;
      const syncTimer = () => {
        const wanted = tracker.active() || cacheClockActive;
        if (wanted && timer === undefined) {
          timer = setInterval(rerender, TICK_MS);
          timer.unref?.();
        } else if (!wanted && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };

      return {
        dispose() {
          unsubBranch?.();
          pi.events?.off?.(WAKE_SOURCE_STATE_EVENT, onWakeSource);
          if (timer !== undefined) clearInterval(timer);
        },
        invalidate() {},
        render(width) {
          const ctx = latestCtx;
          const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
          const cacheLifetime = cacheStatus(branchEntries, resolveCachePolicy(ctx.model));
          cacheClockActive = cacheLifetime?.ticking === true;
          const lines = linesFor(ctx, theme, footerData, width);
          syncTimer();
          return lines;
        },
      };
    });
    return true;
  }

  function paintHostFooter(component, width) {
    try {
      const session = component?.session;
      const ctx = ctxFromHostSession(session, latestCtx?.ui) ?? latestCtx;
      if (ctx) latestCtx = ctx;
      const lines = linesFor(ctx, component?.theme, component?.footerData, width);
      if (Array.isArray(lines) && lines.length > 0) return lines;
    } catch {
      // Keep a Rubato line even if usage or model inspection throws.
    }
    return fallbackStatusLines(component, width);
  }

  function attachHostMode(mode) {
    if (typeof mode?.setExtensionFooter !== "function") return false;
    const ctx = ctxFromHostSession(mode.session, {
      setFooter: (factory) => mode.setExtensionFooter(factory),
    });
    return applyFooter(ctx);
  }

  registerFooterHost({
    paint: paintHostFooter,
    attach: attachHostMode,
  });

  pi.on("session_before_switch", () => {
    speed.resetSession();
  });
  // Model selection only changes which identity is active. Other samples from
  // this session survive so switching back does not restart measurement.
  pi.on("model_select", () => {
    speed.clearIdentity();
  });
  pi.on("agent_end", () => {
    speed.refresh();
  });

  pi.on("session_start", (event, ctx) => {
    // Reload keeps the same process session. Wiping samples here made Speed
    // fall back to — after a config reload that did not change the model.
    if (event?.reason !== "reload") speed.resetSession();
    speed.refresh();
    applyFooter(ctx);
  });
  // MCP attach is awaited on session_start before later extensions run.
  // If the host hook missed, the first turn still replaces the built-in footer.
  pi.on("before_agent_start", (_event, ctx) => {
    applyFooter(ctx);
  });

  return {
    applyFooter,
    attachHostMode,
    paintHostFooter,
    async attachHost() {
      try {
        const { ExtensionRunner } = await import(pathToFileURL(senpiExtensionRunner).href);
        hookExtensionRunnerFooter(ExtensionRunner, applyFooter);
      } catch {
        // Unit tests and non-senpi hosts keep the event-path installer only.
      }
    },
  };
}

/** 남은 상태 키를 한 줄로. 구분자는 첫 줄과 같은 `·` 로 맞춘다. */
function extensionStatusLine(statuses) {
  if (!statuses || statuses.size === 0) return "";
  return Array.from(statuses.entries())
    .filter(([key]) => !HIDDEN_STATUS_KEYS.has(key.trim()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => String(text).replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
}

export default async function statuslineExtension(pi) {
  return runOrDeferExtension(async () => {
    const installed = installStatusline(pi);
    await installed.attachHost?.();
  });
}

// 모듈이 로드되는 즉시 fallback painter 를 심는다. adapter 의 engine import 가
// 끝나기 전에 FooterComponent 가 그려져도 senpi 기본 줄이 나오지 않는다.
if (!footerHost()) {
  registerFooterHost({
    paint: fallbackStatusLines,
    attach() {
      return false;
    },
  });
}

export { HIDDEN_STATUS_KEYS, extensionStatusLine };
