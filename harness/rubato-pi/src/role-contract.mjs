// `companion` is the always-on conversation above the leads (harness/companion); the engine
// sets it for that conversation's runtime only.
export const ROLES = Object.freeze(["lead", "owner", "verifier", "agent", "companion"]);

export function resolveRole({ env = process.env } = {}) {
  const explicit = env.RUBATO_PI_ROLE;
  if (ROLES.includes(explicit)) return explicit;
  if (env.RUBATO_TASK_MEMBER || env.SENPI_TASK_MEMBER) return "owner";
  if (env.PI_CODING_AGENT_SESSION_DIR || env.SENPI_CODING_AGENT_SESSION_DIR) return "agent";
  return "lead";
}
