export const ROLES = Object.freeze(["lead", "owner", "verifier", "agent"]);

export function resolveRole({ env = process.env } = {}) {
  const explicit = env.RUBATO_PI_ROLE;
  if (explicit === "owner" || explicit === "verifier" || explicit === "lead" || explicit === "agent") return explicit;
  if (env.SENPI_TASK_MEMBER) return "owner";
  if (env.SENPI_CODING_AGENT_SESSION_DIR) return "agent";
  return "lead";
}
