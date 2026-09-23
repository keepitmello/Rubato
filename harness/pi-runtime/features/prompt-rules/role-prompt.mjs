export const ROLE_PROMPT_FACTORY_NAME = "rubato-role-prompt";

export const SKILLS_LISTING_ENTRY_TYPE = "rubato.skills-listing";

/**
 * Compose the product role prompt into the session system prompt (every request, every run shape).
 *
 * The skills listing is pinned to the session. It sits in the system prompt, ahead of the whole
 * history, so a skill description edited on disk rewrote the entire cached prefix on the next
 * request or the next restart (2026-09-23: one aside-browser description, 234k tokens re-written).
 * The first composition records the listing as a session entry; later compositions, in this
 * process or after a restart, reuse it. `/reload` (session_start reason "reload") takes the
 * current listing. Skill bodies are read from disk when used, so a pinned description only
 * delays what the model sees in the index, never which instructions it follows.
 */
export function createRolePromptExtension({ env = process.env } = {}) {
  return async (pi) => {
    const promptHref = env.RUBATO_ROLE_PROMPT_MODULE;
    const roleHref = env.RUBATO_ROLE_CONTRACT_MODULE;
    if (!promptHref || !roleHref) return;
    const [{ promptForAgentStart, skillsListingOf, withSkillsListing }, { resolveRole }] = await Promise.all([
      import(promptHref),
      import(roleHref),
    ]);
    const role = resolveRole({ env });
    const pinned = new Map();
    const repin = new Set();
    pi.on("session_start", (event, ctx) => {
      const id = sessionIdOf(ctx);
      if (id === undefined) return;
      pinned.delete(id);
      if (event?.reason === "reload") repin.add(id);
    });
    pi.on("system_prompt", async (event, ctx) => {
      // The role prompt rebuilds the whole prompt from the engine rendering. Handlers that ran
      // before it (context-notes guidance, project rules, todo) appended to that rendering; carry
      // their additions over instead of dropping them. Until 2026-09-23 they were silently lost.
      const base = typeof event.basePrompt === "string" ? event.basePrompt : undefined;
      const current = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
      const additions = base !== undefined && current.startsWith(base) ? current.slice(base.length) : "";
      const rebuilt = promptForAgentStart(base === undefined ? event : { ...event, systemPrompt: base }, ctx, role);
      const composed = additions.trim().length > 0 ? `${rebuilt}\n\n${additions.trim()}` : rebuilt;
      if (typeof skillsListingOf !== "function" || typeof withSkillsListing !== "function") return { systemPrompt: composed };
      const liveListing = skillsListingOf(composed);
      const id = sessionIdOf(ctx);
      if (liveListing === undefined || id === undefined) return { systemPrompt: composed };
      let listing = repin.has(id) ? undefined : pinned.get(id) ?? recordedListing(ctx);
      if (listing === undefined) {
        repin.delete(id);
        listing = liveListing;
        try { pi.appendEntry?.(SKILLS_LISTING_ENTRY_TYPE, { listing }); } catch {}
      }
      pinned.set(id, listing);
      return { systemPrompt: withSkillsListing(composed, listing) };
    });
  };
}

function sessionIdOf(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function recordedListing(ctx) {
  let branch;
  try { branch = ctx?.sessionManager?.getBranch?.(); } catch { return undefined; }
  if (!Array.isArray(branch)) return undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "custom" && entry.customType === SKILLS_LISTING_ENTRY_TYPE && typeof entry.data?.listing === "string") {
      return entry.data.listing;
    }
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

