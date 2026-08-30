import { basename } from "node:path";
import {
  TITLE_ENTRY,
  TITLE_MODEL,
  TITLE_SYSTEM_PROMPT,
  buildTitlePrompt,
  isTitleLocked,
  lastAutoTitle,
  parseTitle,
  shouldRetitle,
  tabTitle,
  userTextsFromEntries,
} from "../session-title.mjs";

function cwdName(ctx) {
  return basename(ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? "");
}

function currentName(pi, ctx) {
  return pi.getSessionName?.() ?? ctx?.sessionManager?.getSessionName?.();
}

export function paintTabTitle(ctx, name) {
  ctx?.ui?.setTitle?.(tabTitle(name, cwdName(ctx)));
}

export function pickTitleModel(registry, fallback) {
  const found = registry?.find?.(TITLE_MODEL.provider, TITLE_MODEL.id);
  return found ?? fallback;
}

export function titleFromResponse(response) {
  return parseTitle(response?.content ?? response);
}

export async function refreshSessionTitle(pi, ctx, state) {
  if (state.locked) return;
  const texts = userTextsFromEntries(ctx.sessionManager?.getEntries?.() ?? ctx.sessionManager?.getBranch?.() ?? []);
  if (texts.length === 0) return;

  const model = pickTitleModel(ctx.modelRegistry, ctx.model);
  const complete = ctx.modelRegistry?.complete;
  if (!model || typeof complete !== "function") return;

  const response = await complete.call(ctx.modelRegistry, model, {
    systemPrompt: TITLE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: buildTitlePrompt(texts) }],
        timestamp: Date.now(),
      },
    ],
  }, {
    cacheRetention: "none",
    sessionId: `rubato-title-${Date.now()}`,
  });

  const proposed = titleFromResponse(response);
  const current = currentName(pi, ctx);
  if (!shouldRetitle({ current, proposed, locked: state.locked })) {
    paintTabTitle(ctx, current);
    return;
  }

  state.lastAuto = proposed;
  pi.setSessionName?.(proposed);
  pi.appendEntry?.(TITLE_ENTRY, { name: proposed });
  paintTabTitle(ctx, proposed);
}

function isNameCommand(text) {
  return /^\/name\s+\S/.test(String(text ?? "").trim());
}

export function installSessionTitle(pi) {
  const state = { lastAuto: undefined, locked: false, inFlight: false };

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    state.lastAuto = lastAutoTitle(entries);
    state.locked = isTitleLocked(entries);
    paintTabTitle(ctx, currentName(pi, ctx));
  });

  pi.on("input", (event) => {
    if (isNameCommand(event?.text)) {
      state.locked = true;
      pi.appendEntry?.(TITLE_ENTRY, { locked: true });
    }
    return { action: "continue" };
  });

  pi.on("session_info_changed", (event, ctx) => {
    if (!event?.name) state.locked = false;
    paintTabTitle(ctx, event?.name);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (state.locked || state.inFlight) return;
    state.inFlight = true;
    try {
      await refreshSessionTitle(pi, ctx, state);
    } catch {
      paintTabTitle(ctx, currentName(pi, ctx));
    } finally {
      state.inFlight = false;
    }
  });
}

export default function sessionTitleExtension(pi) {
  installSessionTitle(pi);
}
