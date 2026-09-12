import { BRAND_NAME } from "./brand.mjs";
import {
  cacheStatus,
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
} from "./statusline.mjs";

const HIDDEN_STATUS_KEYS = new Set(["memory"]);
const MUTED_RED = "\x1b[38;2;196;116;110m";
const RESET = "\x1b[0m";

function remainingColor(remaining) {
  if (remaining == null) return "dim";
  if (remaining > 70) return "success";
  if (remaining > 40) return "warning";
  return "error";
}

function extensionStatusLine(statuses) {
  if (!statuses || statuses.size === 0) return "";
  return Array.from(statuses.entries())
    .filter(([key]) => !HIDDEN_STATUS_KEYS.has(String(key).trim()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => String(text).replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
}

export function ctxFromSession(session) {
  if (!session) return undefined;
  return {
    get cwd() { return session.sessionManager?.getCwd?.() ?? ""; },
    get model() { return session.model; },
    get thinkingLevel() { return session.thinkingLevel; },
    get serviceTier() { return session.effectiveServiceTier ?? session.serviceTier; },
    isFastModeActive() { return session.isFastModeActive?.() === true; },
    getThinkingLevel() { return session.getThinkingLevel?.() ?? session.thinkingLevel; },
    get modelRegistry() { return session.modelRegistry; },
    get sessionManager() { return session.sessionManager; },
    getContextUsage() { return session.getContextUsage?.(); },
  };
}

export function paintStatusLines({
  ctx,
  theme,
  footerData,
  width,
  speedText = "Speed —",
  nowMs = Date.now(),
} = {}) {
  if (!ctx) return ["✦ — · Speed —"];
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
      text: `✦ ${formatModelWithEffort(
        ctx.model?.id,
        ctx.thinkingLevel ?? ctx.getThinkingLevel?.(),
        ctx.model,
        ctx.modelRegistry?.getAll?.(),
        ctx.isFastModeActive?.() === true || ctx.serviceTier === "priority",
      )}`,
      color: "accent",
    },
    { text: formatContext(remaining, window), color: remainingColor(remaining) },
  ];
  if (cacheText) {
    identity.push({
      text: cacheLifetime?.expired ? `${MUTED_RED}${cacheText}${RESET}` : cacheText,
      color: "dim",
    });
  }
  const branch = footerData?.getGitBranch?.();
  if (branch) identity.push({ text: branch, color: "dim" });
  const repo = repoBasename(ctx.cwd);
  if (repo) identity.push({ text: repo, color: "text" });
  const metrics = [{ text: speedText ?? formatFooterMetrics(), color: "dim" }];
  const mark = theme?.fg ? theme.fg("dim", BRAND_NAME) : BRAND_NAME;
  const lines = layoutStatusLines(paint(identity), paint(metrics), width, mark);
  const statusLine = extensionStatusLine(footerData?.getExtensionStatuses?.());
  if (statusLine) lines.push(truncateToWidth(statusLine, width));
  return lines;
}

export function renderRubatoStatusline(component, width, theme = component?.theme) {
  try {
    const lines = paintStatusLines({
      ctx: ctxFromSession(component?.session),
      theme,
      footerData: component?.footerData,
      width,
    });
    if (Array.isArray(lines) && lines.length > 0) return lines;
  } catch {
    // Keep a Rubato line even if usage or model inspection throws.
  }
  return ["✦ — · Speed —"];
}

export class RubatoFooter {
  constructor(session, footerData, theme) {
    this.session = session;
    this.footerData = footerData;
    this.theme = theme;
  }
  setSession(session) { this.session = session; }
  setAutoCompactEnabled() {}
  invalidate() {}
  dispose() {}
  render(width) { return renderRubatoStatusline(this, width, this.theme); }
}

export function createRubatoFooter(session, footerData, theme) {
  return new RubatoFooter(session, footerData, theme);
}
