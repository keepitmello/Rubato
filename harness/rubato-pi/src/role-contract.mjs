export const ROLES = Object.freeze(["lead", "owner", "verifier"]);

export function resolveRole({ env = process.env } = {}) {
  const explicit = env.RUBATO_PI_ROLE;
  if (explicit === "owner" || explicit === "verifier" || explicit === "lead") return explicit;
  if (env.SENPI_TASK_MEMBER) return "owner";
  return "lead";
}
