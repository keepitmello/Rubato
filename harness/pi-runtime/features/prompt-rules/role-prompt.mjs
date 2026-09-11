export const ROLE_PROMPT_FACTORY_NAME = "rubato-role-prompt";

/** Inject the product role prompt on every agent start, matching Senpi adapter.mjs. */
export function createRolePromptExtension({ env = process.env } = {}) {
  return async (pi) => {
    const promptHref = env.RUBATO_ROLE_PROMPT_MODULE;
    const roleHref = env.RUBATO_ROLE_CONTRACT_MODULE;
    if (!promptHref || !roleHref) return;
    const [{ promptForAgentStart }, { resolveRole }] = await Promise.all([
      import(promptHref),
      import(roleHref),
    ]);
    const role = resolveRole({ env });
    pi.on("before_agent_start", async (event, ctx) => ({
      systemPrompt: promptForAgentStart(event, ctx, role),
    }));
  };
}

export function createRolePromptExtensionFactories({ env = process.env } = {}) {
  return [{
    name: ROLE_PROMPT_FACTORY_NAME,
    factory: createRolePromptExtension({ env }),
  }];
}

export default createRolePromptExtensionFactories;

