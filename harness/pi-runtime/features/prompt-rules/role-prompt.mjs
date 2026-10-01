export const ROLE_PROMPT_FACTORY_NAME = "rubato-role-prompt";

export const SKILLS_LISTING_ENTRY_TYPE = "rubato.skills-listing";

export const ROLE_PROMPT_ENTRY_TYPE = "rubato.role-prompt";

export const PROJECT_CONTEXT_ENTRY_TYPE = "rubato.project-context";

export const PROJECT_RULES_ENTRY_TYPE = "rubato.project-rules";

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
 */
export function createRolePromptExtension({ env = process.env } = {}) {
  return async (pi) => {
    const promptHref = env.RUBATO_ROLE_PROMPT_MODULE;
    const roleHref = env.RUBATO_ROLE_CONTRACT_MODULE;
    if (!promptHref || !roleHref) return;
    const [{ loadRolePrompt, promptForAgentStart, skillsListingOf }, { resolveRole }] = await Promise.all([
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
      if (value === undefined) {
        value = live();
        try { pi.appendEntry?.(type, { value }); } catch {}
      }
      session.set(type, value);
      return value;
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
        ? {}
        : { loadRolePrompt: () => pin(id, ctx, ROLE_PROMPT_ENTRY_TYPE, () => loadRolePrompt(role, { env })) };
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
      return { systemPrompt: composed };
    });
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
  let branch;
  try { branch = ctx?.sessionManager?.getBranch?.(); } catch { return undefined; }
  if (!Array.isArray(branch)) return undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== customType) continue;
    const value = entry.data?.value ?? entry.data?.listing;
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function createRolePromptExtensionFactories({ env = process.env } = {}) {
  return [{
    name: ROLE_PROMPT_FACTORY_NAME,
    factory: createRolePromptExtension({ env }),
  }];
}

export default createRolePromptExtensionFactories;

