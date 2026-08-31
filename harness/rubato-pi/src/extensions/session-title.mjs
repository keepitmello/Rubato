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
  state.applyingAuto = true;
  try {
    pi.setSessionName?.(proposed);
    pi.appendEntry?.(TITLE_ENTRY, { name: proposed });
    paintTabTitle(ctx, proposed);
  } finally {
    state.applyingAuto = false;
  }
}

function isNameCommand(text) {
  return /^\/name\s+\S/.test(String(text ?? "").trim());
}

function lockExplicitTitle(pi, state) {
  if (state.locked) return;
  state.locked = true;
  pi.appendEntry?.(TITLE_ENTRY, { locked: true });
}

function decorateInteractiveControl(control, setSessionName) {
  const wrapper = {};
  for (const key of Reflect.ownKeys(control)) {
    const descriptor = Object.getOwnPropertyDescriptor(control, key);
    if (!descriptor) continue;
    if (key === "setSessionName" && typeof descriptor.value === "function") {
      Object.defineProperty(wrapper, key, { ...descriptor, value: setSessionName });
      continue;
    }
    if (typeof descriptor.value === "function") {
      Object.defineProperty(wrapper, key, { ...descriptor, value: descriptor.value.bind(control) });
      continue;
    }
    Object.defineProperty(wrapper, key, descriptor);
  }
  return wrapper;
}

function installRenameLock(pi, state) {
  const original = pi.getInteractiveControl;
  if (typeof original !== "function") return;
  const wrappers = new WeakMap();
  pi.getInteractiveControl = () => {
    let control;
    try {
      control = original.call(pi);
    } catch {
      // switchSession invalidates the captured pi. A throw here aborts the
      // resumed turn and senpi then process.exit(1).
      return undefined;
    }
    if (!control || typeof control.setSessionName !== "function") return control;
    const cached = wrappers.get(control);
    if (cached) return cached;
    const setSessionName = control.setSessionName.bind(control);
    const wrapper = decorateInteractiveControl(control, (name) => {
      if (!state.applyingAuto) lockExplicitTitle(pi, state);
      return setSessionName(name);
    });
    wrappers.set(control, wrapper);
    return wrapper;
  };
}

export function installSessionTitle(pi) {
  const state = { lastAuto: undefined, locked: false, inFlight: false, applyingAuto: false };
  installRenameLock(pi, state);

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    state.lastAuto = lastAutoTitle(entries);
    state.locked = isTitleLocked(entries);
    paintTabTitle(ctx, currentName(pi, ctx));
  });

  pi.on("input", (event) => {
    if (isNameCommand(event?.text)) lockExplicitTitle(pi, state);
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
