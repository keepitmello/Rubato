export const MAX_ENV_SLOT_INDEX = 16;

const PRIMARY_ENV = Object.freeze({
  xai: "XAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  kiro: "KIRO_API_KEY",
  "openai-codex": "OPENAI_API_KEY",
});

export function primaryEnvVar(providerId) {
  return PRIMARY_ENV[providerId];
}

export function discoverEnvSlots(providerId, env) {
  const primary = primaryEnvVar(providerId);
  if (!primary) return [];
  const slots = [];
  const base = env(primary);
  if (base) slots.push({ name: "env", envVarName: primary, key: base, source: "env" });
  for (let index = 2; index <= MAX_ENV_SLOT_INDEX; index++) {
    const envVarName = `${primary}_${index}`;
    const value = env(envVarName);
    if (value) slots.push({ name: `env-${index}`, envVarName, key: value, source: "env" });
  }
  return slots;
}
