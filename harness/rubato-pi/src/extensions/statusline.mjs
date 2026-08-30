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
    cachedText() {
      return formatFooterMetrics({ speed: speedStore?.getCachedScore?.() });
    },
  };
}

export function installStatusline(pi, { processStartedAt = PROCESS_STARTED_AT, speedStore = speedIndexStore() } = {}) {
  void processStartedAt;
  const speed = bindSpeedStore(speedStore);

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

  pi.on("session_start", (_event, ctx) => {
    speed.resetSession();
    speed.refresh();
    if (typeof ctx.ui?.setFooter !== "function") return;

    const tracker = createBackgroundTracker();

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
          tracker.clear();
        },
        invalidate() {},
        render(width) {
          const usage = ctx.getContextUsage?.();
          const remaining = remainingPercent(usage?.percent);
          const window = usage?.contextWindow ?? ctx.model?.contextWindow;
          const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
          const cachePolicy = resolveCachePolicy(ctx.model);
          const cacheLifetime = cacheStatus(branchEntries, cachePolicy);
          cacheClockActive = cacheLifetime?.ticking === true;
          const cache = sessionCacheHitPercent(branchEntries);
          const cacheText = formatCacheSegment(cache, cacheLifetime);
          const paint = (parts) => parts
            .map((part) => (theme?.fg ? theme.fg(part.color, part.text) : part.text))
            .join(" · ");
          const identity = [
            {
              text: `✦ ${formatModelWithEffort(ctx.model?.id, ctx.thinkingLevel ?? ctx.getThinkingLevel?.(), ctx.model, ctx.modelRegistry?.getAll?.())}`,
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
          const branch = footerData.getGitBranch?.();
          if (branch) identity.push({ text: branch, color: "dim" });
          const repo = repoBasename(ctx.cwd);
          if (repo) identity.push({ text: repo, color: "text" });
          const metrics = [{ text: speed.cachedText(), color: "dim" }];
          const mark = theme?.fg ? theme.fg("dim", BRAND_NAME) : BRAND_NAME;
          const lines = layoutStatusLines(paint(identity), paint(metrics), width, mark);

          syncTimer();
          const background = formatBackgroundLine(tracker.groups(), Date.now(), width);
          if (background) {
            lines.push(truncateToWidth(theme?.fg ? theme.fg("dim", background) : background, width));
          }

          const statusLine = extensionStatusLine(footerData.getExtensionStatuses?.());
          if (statusLine) lines.push(truncateToWidth(statusLine, width));
          return lines;
        },
      };
    });
  });
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

export default function statuslineExtension(pi) {
  installStatusline(pi);
}

export { HIDDEN_STATUS_KEYS, extensionStatusLine };
