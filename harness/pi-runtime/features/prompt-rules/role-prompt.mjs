export const ROLE_PROMPT_FACTORY_NAME = "rubato-role-prompt";

export const SKILLS_LISTING_ENTRY_TYPE = "rubato.skills-listing";

export const ROLE_PROMPT_ENTRY_TYPE = "rubato.role-prompt";

export const PROJECT_CONTEXT_ENTRY_TYPE = "rubato.project-context";

export const PROJECT_RULES_ENTRY_TYPE = "rubato.project-rules";

export const OPENING_TURN_ENTRY_TYPE = "rubato.opening-turn";

// The always-on companion's role (harness/companion COMPANION_ROLE; that module is not staged
// with these runtime files).
export const COMPANION_ROLE = "companion";

// session-prompt's replacement entry (its patches.mjs is the source, not staged with these
// runtime files): a session holding one runs on that text alone.
export const SYSTEM_PROMPT_REPLACEMENT_ENTRY_TYPE = "rubato.system-prompt";

// What a server compaction leaves in an answer (compaction/anthropic-server-compaction.mjs
// isAnthropicCompactionBlock; a persisted session contract, not staged with these files).
export const SERVER_COMPACTION_BLOCK = Object.freeze({ type: "providerNative", subtype: "compaction" });

const PROJECT_CONTEXT = /<project_context>[\s\S]*?<\/project_context>/;
const PROJECT_RULES = /<!--senpi:project-rules:1:start-->[\s\S]*?<!--senpi:project-rules:1:end-->/;

/**
 * Compose the product role prompt into the session system prompt (every request, every run shape).
 *
 * Everything read from disk into the system prompt is pinned to the session: the role prompt
 * file, the skills listing, the project instructions (CLAUDE.md, AGENTS.md) and the static project
 * rules. They sit ahead of the whole history, so an edit on disk rewrote the entire cached prefix
 * on the next request or the next restart (2026-09-23: one aside-browser description, 234k tokens
 * re-written). The first composition records each one as a session entry, an absent one as "";
 * later compositions, in this process or after a restart, reuse them, so an edit reaches new
 * sessions only. `/reload` (session_start reason "reload") takes the current files. Skill bodies
 * are read from disk when used, so a pinned description only delays what the model sees in the
 * index, never which instructions it follows.
 *
 * The companion is one conversation that never ends, so "new sessions only" would mean never. Its
 * role prompt is pinned the same way, and pinned again when the conversation crosses a compaction
 * or a new window (a server compaction, compact_context, new_context): the cached prefix is
 * rewritten there anyway, so the pieces as they are on disk then cost nothing extra. A piece
 * edited in between, by an update or in Settings › Companion, waits for that point.
 */
export function createRolePromptExtension({ env = process.env } = {}) {
  return async (pi) => {
    const promptHref = env.RUBATO_ROLE_PROMPT_MODULE;
    const roleHref = env.RUBATO_ROLE_CONTRACT_MODULE;
    if (!promptHref || !roleHref) return;
    const [{ loadRolePrompt, promptForAgentStart, skillsListingOf, loadOpeningTurn, codaLast }, { resolveRole }] = await Promise.all([
      import(promptHref),
      import(roleHref),
    ]);
    const role = resolveRole({ env });
    const sections = [
      { type: PROJECT_CONTEXT_ENTRY_TYPE, of: (prompt) => prompt.match(PROJECT_CONTEXT)?.[0] },
      { type: PROJECT_RULES_ENTRY_TYPE, of: (prompt) => prompt.match(PROJECT_RULES)?.[0] },
    ];
    if (typeof skillsListingOf === "function") sections.push({ type: SKILLS_LISTING_ENTRY_TYPE, of: skillsListingOf });
    const pinned = new Map();
    const repin = new Set();
    pi.on("session_start", (event, ctx) => {
      const id = sessionIdOf(ctx);
      if (id === undefined) return;
      pinned.delete(id);
      if (event?.reason === "reload") repin.add(id);
    });
    // The pinned value of one entry type for this session; `live` supplies it the first time.
    const pin = (id, ctx, type, live) => {
      if (!pinned.has(id)) pinned.set(id, new Map());
      const session = pinned.get(id);
      let value = repin.has(id) ? undefined : session.get(type) ?? recordedEntry(ctx, type);
      const current = value === undefined ? live() : undefined;
      if (current !== undefined && current !== value) {
        value = current;
        try { pi.appendEntry?.(type, { value }); } catch {}
      }
      session.set(type, value);
      return value;
    };
    // The companion's role prompt: pinned with the last compaction or new window it was read
    // after (`boundary`, that entry's id, null before the first). Crossing another one reads the
    // pieces again. A pin recorded before this rule has no boundary and is read again once.
    const pinAtBoundary = (id, ctx, type, live) => {
      if (!pinned.has(id)) pinned.set(id, new Map());
      const session = pinned.get(id);
      const boundary = lastBoundary(ctx);
      let held = repin.has(id) ? undefined : session.get(type) ?? recordedData(ctx, type);
      if (held === undefined || held.boundary !== boundary) {
        held = { value: live(), boundary };
        try { pi.appendEntry?.(type, held); } catch {}
      }
      session.set(type, held);
      return held.value;
    };
    pi.on("system_prompt", async (event, ctx) => {
      // The role prompt rebuilds the whole prompt from the engine rendering. Handlers that ran
      // before it (context-notes guidance, project rules, todo) appended to that rendering; carry
      // their additions over instead of dropping them. Until 2026-09-23 they were silently lost.
      const base = typeof event.basePrompt === "string" ? event.basePrompt : undefined;
      const current = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
      const additions = base !== undefined && current.startsWith(base) ? current.slice(base.length) : "";
      const id = sessionIdOf(ctx);
      const hooks = id === undefined || typeof loadRolePrompt !== "function"
        ? { renderCoda: false }
        : { renderCoda: false, loadRolePrompt: () => (role === COMPANION_ROLE ? pinAtBoundary : pin)(id, ctx, ROLE_PROMPT_ENTRY_TYPE,
          () => loadRolePrompt(role, { env })) };
      const rebuilt = promptForAgentStart(base === undefined ? event : { ...event, systemPrompt: base }, ctx, role, hooks);
      let composed = additions.trim().length > 0 ? `${rebuilt}\n\n${additions.trim()}` : rebuilt;
      if (id !== undefined) {
        for (const section of sections) {
          const live = section.of(composed);
          const value = pin(id, ctx, section.type, () => live ?? "");
          // A section that appeared after pinning has no place to restore; one pinned as absent
          // is removed so a file added mid-session reaches new sessions only.
          if (live !== undefined && live !== value) composed = value === "" ? without(composed, live) : composed.replace(live, () => value);
        }
        repin.delete(id);
      }
      // The companion's closing piece is the last thing in the prompt, after the additions too
      // (Roo build.sh: "마지막 토큰 슬롯을 루 목소리로 점유").
      if (typeof codaLast === "function") composed = codaLast(composed);
      return { systemPrompt: composed };
    });
    // The opening turn: an assistant turn ahead of the whole conversation, in the model's own
    // voice, answering the welcome that ends the preamble. Like the role prompt it is pinned to
    // the session, so it never moves and never changes under a cached prefix. A session that
    // already has replies when it first meets this code pins it as absent: placing it ahead of
    // existing history would rewrite that session's whole cached prefix. `/reload` keeps it too,
    // for the same reason.
    const openings = new Map();
    pi.on("context", (event, ctx) => {
      if (typeof loadOpeningTurn !== "function") return;
      const id = sessionIdOf(ctx);
      if (id === undefined) return;
      let text = openings.get(id) ?? recordedEntry(ctx, OPENING_TURN_ENTRY_TYPE);
      if (text === undefined) {
        // The opening turn answers the product preamble; a session opened with its own whole
        // prompt (session-prompt's replacement entry) has no preamble to answer.
        const started = event.messages.some((message) => message?.role === "assistant");
        const replaced = recordedEntry(ctx, SYSTEM_PROMPT_REPLACEMENT_ENTRY_TYPE) !== undefined;
        text = started || replaced ? "" : loadOpeningTurn({ env });
        try { pi.appendEntry?.(OPENING_TURN_ENTRY_TYPE, { value: text }); } catch {}
      }
      openings.set(id, text);
      if (!text) return;
      return { messages: [openingTurnMessage(text), ...event.messages] };
    });
  };
}

/** A finished assistant turn the provider adapters replay as plain text from another model. */
export function openingTurnMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "rubato-opening",
    provider: "rubato",
    model: "rubato-opening",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  };
}

// Drop a section the way the prompt is joined, so the result matches a composition without it.
function without(prompt, section) {
  const start = prompt.indexOf(section);
  const before = prompt.slice(0, start).trimEnd();
  const after = prompt.slice(start + section.length).trimStart();
  return before && after ? `${before}\n\n${after}` : before + after;
}

function sessionIdOf(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

// Skills-listing entries in existing sessions carry the text under `listing`.
function recordedEntry(ctx, customType) {
  const data = recordedData(ctx, customType);
  const value = data?.value ?? data?.listing;
  return typeof value === "string" ? value : undefined;
}

/** The latest entry of `customType` on this branch whose value is text: `{ value, boundary? }`. */
function recordedData(ctx, customType) {
  let branch;
  try { branch = ctx?.sessionManager?.getBranch?.(); } catch { return undefined; }
  if (!Array.isArray(branch)) return undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== customType) continue;
    const value = entry.data?.value ?? entry.data?.listing;
    if (typeof value === "string") return { value, ...(entry.data && "boundary" in entry.data ? { boundary: entry.data.boundary } : {}) };
  }
  return undefined;
}

/**
 * The id of the last point on this branch where the conversation's prefix was rewritten: a
 * compaction entry (a new window, or a summary) or an answer carrying a server compaction. null
 * when there is none yet.
 */
export function lastBoundary(ctx) {
  let branch;
  try { branch = ctx?.sessionManager?.getBranch?.(); } catch { return null; }
  if (!Array.isArray(branch)) return null;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "compaction") return entry.id ?? null;
    const content = entry?.type === "message" && entry.message?.role === "assistant" ? entry.message.content : undefined;
    if (Array.isArray(content) && content.some((block) => block?.type === SERVER_COMPACTION_BLOCK.type
      && block.subtype === SERVER_COMPACTION_BLOCK.subtype && typeof block.raw?.content === "string" && block.raw.content.length > 0)) {
      return entry.id ?? null;
    }
  }
  return null;
}

export function createRolePromptExtensionFactories({ env = process.env } = {}) {
  return [{
    name: ROLE_PROMPT_FACTORY_NAME,
    factory: createRolePromptExtension({ env }),
  }];
}

export default createRolePromptExtensionFactories;

