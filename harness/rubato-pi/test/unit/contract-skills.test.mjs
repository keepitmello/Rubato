import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_SKILLS_INSTRUCTIONS,
  CONTRACT_SKILLS_TYPE,
  contractSkillsMessage,
  sessionHasContractSkills,
  shouldInjectContractSkills,
} from "../../src/contract-skills.mjs";

test("startup injects a hidden role-specific contract instruction", () => {
  assert.equal(shouldInjectContractSkills("startup"), true);
  assert.equal(shouldInjectContractSkills("new"), true);
  assert.equal(shouldInjectContractSkills("fork"), true);
  assert.equal(shouldInjectContractSkills("resume"), true);
  assert.equal(shouldInjectContractSkills("reload"), false);

  const lead = contractSkillsMessage("lead");
  assert.equal(lead.customType, CONTRACT_SKILLS_TYPE);
  assert.equal(lead.display, false);
  assert.equal(lead.content, CONTRACT_SKILLS_INSTRUCTIONS.lead);
  assert.match(lead.content, /Skill\(dispatching\)/);
  assert.doesNotMatch(lead.content, /Skill\(dispatched\)/);

  const owner = contractSkillsMessage("owner");
  assert.equal(owner.content, CONTRACT_SKILLS_INSTRUCTIONS.owner);
  assert.match(owner.content, /Skill\(dispatching\)/);
  assert.match(owner.content, /Skill\(dispatched\)/);

  const verifier = contractSkillsMessage("verifier");
  assert.equal(verifier.content, CONTRACT_SKILLS_INSTRUCTIONS.verifier);
  assert.doesNotMatch(verifier.content, /Skill\(dispatching\)/);
  assert.match(verifier.content, /Skill\(dispatched\)/);
});

test("does not inject again when the session already has the instruction", () => {
  const entries = [{ type: "custom_message", customType: CONTRACT_SKILLS_TYPE }];
  assert.equal(sessionHasContractSkills(entries), true);
  assert.equal(shouldInjectContractSkills("startup", entries), false);
  assert.equal(shouldInjectContractSkills("resume", entries), false);
});
