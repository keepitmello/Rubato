import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promptNameForRole } from "../../src/system-prompt.mjs";

// The role prompts are their own files now. These assertions used to guard a
// runtime string replacement; they guard the built pieces instead, so a stray
// fx rail cannot reach a pi session.
function rolePrompt(role) {
  return readFileSync(join(homedir(), ".agents/rubato/.build", promptNameForRole(role)), "utf8");
}

const promptSourceRoot = join(import.meta.dirname, "../../../prompts");

test("lead prompt names the pi rails and no fx ones", () => {
  const text = rolePrompt("lead");
  assert.match(text, /running on Rubato's Senpi-based runtime/);
  assert.match(text, /`task` tool/);
  assert.match(text, /team_create/);
  // team_create 승인 절차는 Skill(agent-taskforce) 가 소유하고, 일회성 task Agent는
  // lead 판단으로 바로 쓴다. 문장 대신 그 권한 배치를 고정한다.
  assert.match(text, /`task` agents are available at your discretion/);
  assert.match(text, /run Skill\(agent-taskforce\) before `team_create`/);
  // Phrased "You choose each child's model" until the vocabulary moved from child to
  // agent. The invariant is that the lead owns per-agent model choice, not the noun it
  // was written with — this is the third time this file pinned a sentence and broke on a
  // rewrite that kept the meaning. Assert the invariant.
  assert.match(text, /You choose each agent's cognitive profile and semantic category/);
  assert.match(text, /semantic model category/);
  assert.match(text, /runtimes\/pi\.md/);

  assert.doesNotMatch(text, /fork of the fx harness/);
  assert.doesNotMatch(text, /## Rails — fx/);
  assert.doesNotMatch(text, /`subagent` tool/);
  assert.doesNotMatch(text, /fx models/);
  assert.doesNotMatch(text, /rubato dispatch/);
  assert.doesNotMatch(text, /FX_MODEL/);
  assert.doesNotMatch(text, /FX_SUBAGENT_SYSTEM_PROMPT_FILE/);
  assert.doesNotMatch(text, /~\/\.fx\//);
  assert.doesNotMatch(text, /\/approve-spawn/);
});

// "child" as a word for a spawned agent is what collapsed lead/teammate/agent into one
// axis: it makes what the lead spawned and what a teammate spawned look like different
// kinds. Both are agents. The word survives only as an API parameter (`subagent_type`)
// and for OS process trees, neither of which appears in these prompts.
test("role prompts do not call a spawned agent a child", () => {
  for (const role of ["lead", "owner"]) {
    assert.doesNotMatch(rolePrompt(role), /\bchildren\b/i);
    assert.doesNotMatch(rolePrompt(role), /\bchild\b/i);
  }
});

test("lead prompt keeps lead, teammate, and agent on separate axes", () => {
  const text = rolePrompt("lead");
  assert.match(text, /a teammate spawns/);
  assert.match(text, /always an owner/);
});

test("teammate prompt points helpers at task, not subagent", () => {
  const text = rolePrompt("owner");
  // The prompt used to say "Use the `task` tool" verbatim; 32b1ba97a rewrote that
  // paragraph and this assertion kept naming a sentence that no longer exists, so the
  // test failed on generated text while the intent it guards — point helpers at `task`,
  // never at `subagent` — was still satisfied. Assert the intent, not the old wording.
  assert.match(text, /`task`/);
  assert.match(text, /Completion notifications deliver terminal results; `task_output` reads an immediate status or transcript snapshot/);
  assert.doesNotMatch(text, /`task_output` waits/);
  assert.doesNotMatch(text, /`subagent` tool/);
  assert.doesNotMatch(text, /fx models/);
  assert.doesNotMatch(text, /rubato dispatch/);
  assert.doesNotMatch(text, /~\/\.fx\//);
});

test("lead, owner, and verifier carry the bidirectional brief contract", () => {
  for (const role of ["lead", "owner", "verifier"]) {
    const text = rolePrompt(role);
    assert.match(text, /Leads, workstream owners, and verifiers exchange briefs in both directions/);
    assert.match(text, /you receive briefs and write them/);
    assert.match(text, /When receiving/);
    assert.match(text, /When writing/);
    assert.match(text, /A budget return and a well-supported absent finding are complete outcomes/);
  }
});

test("assigned agents carry the receive-and-return contract", () => {
  const text = rolePrompt("agent");
  assert.match(text, /Execute the bounded outcome in the brief and return evidence/);
  assert.match(text, /Treat claims about code locations, mechanisms, causes, and likely files as leads/);
  assert.doesNotMatch(text, /exchange briefs in both directions/);
  assert.doesNotMatch(text, /`task`/);
  assert.doesNotMatch(text, /team_create/);
});

test("both role prompts defer independent-review routing to the model guide", () => {
  for (const role of ["lead", "owner"]) {
    const text = rolePrompt(role);
    assert.match(text, /Skill\(model-guide\)/);
    assert.match(text, /material or ambiguous outcome where independent falsification can change the decision/);
    assert.doesNotMatch(text, /When the work and its verification are complete, take one independent review/);
    assert.doesNotMatch(text, /if the main session runs a Claude model, use `sol`/);
    assert.doesNotMatch(text, /if it runs a Codex model, use `opus`/);
    assert.doesNotMatch(text, /take one independent review from `sol`\./);
  }
});

test("role prompts delegate provider resolution and fallback to the harness", () => {
  for (const role of ["lead", "owner"]) {
    const text = rolePrompt(role);
    assert.match(text, /semantic model category/);
    assert.match(text, /harness owns provider choice|harness resolves/);
    assert.doesNotMatch(text, /Copy the model id from the live catalog/);
  }
});

test("Consult routing starts from local evidence and expands on material external value", () => {
  for (const role of ["lead", "owner"]) {
    const text = rolePrompt(role);
    assert.match(text, /Build the map from workspace evidence/);
    assert.match(text, /current external evidence, unfamiliar-domain research, or an independent view can materially change a costly decision/);
    assert.doesNotMatch(text, /research it through Skill\(consult\).*not as a last resort/);
  }
});

test("shared prompt carries the keep-simple invariant directly", () => {
  for (const role of ["lead", "owner", "verifier", "agent"]) {
    const text = rolePrompt(role);
    assert.match(text, /Build the smallest correct change that owns the requested behavior/);
    assert.match(text, /Preserve safety, validation, meaningful errors, tests, and explicit requirements while simplifying/);
    assert.doesNotMatch(text, /Skill\(keep-simple\)/);
  }
});

test("built role prompts contain their current source fragments", () => {
  const cases = [
    ["lead", ["base.pi.md", "brief-exchange.pi.md", "core-lead.pi.md", "voice.md"]],
    ["owner", ["base.pi.md", "brief-exchange.pi.md", "core-teammate.pi.md", "voice.md"]],
    ["agent", ["base.pi.md", "core-agent.pi.md", "voice.md"]],
  ];
  for (const [role, fragments] of cases) {
    const built = rolePrompt(role);
    for (const fragment of fragments) {
      const source = readFileSync(join(promptSourceRoot, fragment), "utf8").trim();
      assert.ok(built.includes(source), `${role} prompt is stale for ${fragment}`);
    }
  }
});
