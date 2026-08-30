export const CONTRACT_SKILLS_TYPE = "rubato-pi-contract-skills";

export const CONTRACT_SKILLS_INSTRUCTIONS = Object.freeze({
  lead: "Before you hand work to another session, read Skill(dispatching).",
  owner: "When you start from a brief, read Skill(dispatched). Before you hand work to another session, read Skill(dispatching).",
  verifier: "When you start from a brief, read Skill(dispatched).",
});

const INJECT_REASONS = new Set(["startup", "new", "fork", "resume"]);

export function sessionHasContractSkills(entries = []) {
  return entries.some(
    (entry) => entry?.type === "custom_message" && entry.customType === CONTRACT_SKILLS_TYPE,
  );
}

export function shouldInjectContractSkills(reason, entries = []) {
  return INJECT_REASONS.has(reason) && !sessionHasContractSkills(entries);
}

export function contractSkillsMessage(role = "lead") {
  return {
    customType: CONTRACT_SKILLS_TYPE,
    content: CONTRACT_SKILLS_INSTRUCTIONS[role] ?? CONTRACT_SKILLS_INSTRUCTIONS.lead,
    display: false,
  };
}
