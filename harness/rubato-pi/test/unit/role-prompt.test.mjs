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
  // 785f6a3f9 halved the Rails section: tool-naming detail moved to
  // Skill(agent-taskforce). The lead names the rails, the skill owns the flags.
  assert.match(text, /`Agent` is the rail for a result you take back/);
  assert.match(text, /team_create/);
  assert.match(text, /`cs-agent dispatch` is an emergency route/);
  assert.match(text, /Auth is the rubato broker at `:8788`/);
  assert.match(text, /report the roster in one message and form the team in the same turn/);
  assert.doesNotMatch(text, /semantic `category`/);
  assert.doesNotMatch(text, /`subagent_type`/);
  // team_create 승인 절차는 Skill(agent-taskforce) 가 소유하고, 일회성 Agent는
  // lead 판단으로 바로 쓴다. 문장 대신 그 권한 배치를 고정한다.
  // 785f6a3f9 reworded the contrast: teams form on veto, the one-off rail needs
  // no approval, and the owner-discretion sentence lives in runtimes/pi.md now.
  assert.match(text, /the user vetoes rather than approves/);
  assert.match(text, /Read Skill\(agent-taskforce\) `LEAD\.md` and `runtimes\/pi\.md` before `team_create`/);
  // Phrased "You choose each child's model" until the vocabulary moved from child to
  // agent. The invariant is that the lead owns per-agent model choice, not the noun it
  // was written with — this is the third time this file pinned a sentence and broke on a
  // rewrite that kept the meaning. Assert the invariant.
  assert.match(text, /Choose each agent's cognitive profile with Skill\(model-guide\)/);
  assert.match(text, /exact `model` or named `preset`/);
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
  // 785f6a3f9: spawn-relation wording flattened, and a verifier is now a teammate
  // kind ("as owner or as verifier"), not just an owner. Axes stay separate.
  assert.match(text, /whether you or a teammate spawned it/);
  assert.match(text, /as owner or as verifier/);
  assert.match(text, /An agent is anything spawned to do work/);
});

test("teammate prompt points helpers at Agent, not subagent", () => {
  const text = rolePrompt("owner");
  // The prompt used to say "Use the `task` tool" verbatim; 32b1ba97a rewrote that
  // paragraph and this assertion kept naming a sentence that no longer exists, so the
  // test failed on generated text while the intent it guards — point helpers at `Agent`,
  // never at `subagent` — was still satisfied. Assert the intent, not the old wording.
  assert.match(text, /`Agent`/);
  // Agent lifecycle and board detail moved from core-teammate.pi.md to the pi
  // runtime skill in 785f6a3f9 ("rules in one place"); the role prompt keeps
  // the pointer (model-guide) and the mailbox (team_send). The seat rewrite made
  // parallel `Agent` subagents the default and reuse of the same subagent the rule.
  assert.match(text, /Delegate by cost, not by count/);
  assert.match(text, /goes to the same subagent with `AgentSend`/);
  assert.match(text, /choose each agent's model with Skill\(model-guide\)/);
  assert.match(text, /team_send/);
  const piRuntime = readFileSync(join(promptSourceRoot, "../skills/agent-taskforce/runtimes/pi.md"), "utf8");
  assert.match(piRuntime, /completion notifications deliver terminal results/);
  assert.match(piRuntime, /`AgentOutput` reads an immediate midpoint snapshot/);
  assert.match(piRuntime, /Rubato team tasklist on disk/);
  assert.match(piRuntime, /Omit `effort` unless you need a manual override/);
  assert.doesNotMatch(text, /`AgentOutput` waits/);
  assert.doesNotMatch(text, /`subagent` tool/);
  assert.doesNotMatch(text, /fx models/);
  assert.doesNotMatch(text, /rubato dispatch/);
  assert.doesNotMatch(text, /~\/\.fx\//);
});

test("lead, owner, and verifier carry the bidirectional brief contract", () => {
  for (const role of ["lead", "owner", "verifier"]) {
    const text = rolePrompt(role);
    assert.match(text, /Leads, workstream owners, and verifiers exchange briefs in both directions/);
    // Receiving stays in the role contract; the writing procedure has one owner.
    assert.match(text, /When writing a brief or intervening in stalled work, follow Skill\(dispatching\)/);
    assert.match(text, /When receiving/);
    assert.match(text, /When writing/);
    assert.match(text, /A budget return and a well-supported absent finding are complete outcomes/);
  }
});

test("dispatching owns the brief-writing checklist and stalled-work procedure", () => {
  const skill = readFileSync(join(promptSourceRoot, "../skills/dispatching/SKILL.md"), "utf8");
  for (const rule of [
    /The outcome and why it matters/,
    /Done evidence/,
    /Write ownership and off-limits paths/,
    /The budget/,
    /Name a number/,
    /Constraints that carry a named authority source/,
    /Provisional:/,
    /read scope apart from write scope/,
    /nothing new appears/,
    /Recover the cause from the same session first/,
  ]) assert.match(skill, rule);
  for (const role of ["lead", "owner", "verifier"]) {
    const text = rolePrompt(role);
    assert.match(text, /Before you spawn an `Agent` or send one a follow-up, read Skill\(dispatching\)/);
    assert.doesNotMatch(text, /give the next owner a bounded outcome/);
    assert.doesNotMatch(text, /the budget at which it reports back/);
  }
  assert.match(rolePrompt("lead"), /Delegate bounded outcomes; leave the how to the owner/);
  assert.match(rolePrompt("lead"), /Before you dispatch, check what is already modified/);
  assert.match(rolePrompt("lead"), /Judgment across workstreams .* is yours and is not delegated/);
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
    // Lead says "could change", teammate says "can change" — same routing rule.
    assert.match(text, /independent falsification (can|could) change the decision/);
    assert.doesNotMatch(text, /When the work and its verification are complete, take one independent review/);
    assert.doesNotMatch(text, /if the main session runs a Claude model, use `sol`/);
    assert.doesNotMatch(text, /if it runs a Codex model, use `opus`/);
    assert.doesNotMatch(text, /take one independent review from `sol`\./);
  }
});

test("model-guide and pi runtime tell Agent callers to use model or preset, not category", () => {
  const modelGuide = readFileSync(join(promptSourceRoot, "../skills/model-guide/SKILL.md"), "utf8");
  const piRuntime = readFileSync(join(promptSourceRoot, "../skills/agent-taskforce/runtimes/pi.md"), "utf8");
  for (const text of [modelGuide, piRuntime]) {
    assert.match(text, /exact `model` or named `preset`/);
    assert.doesNotMatch(text, /Pass the corresponding semantic `category`/);
    assert.doesNotMatch(text, /`task` or `team_create`/);
  }
  // 7a4b8d79c changed Muse effort to high/xhigh like Grok, so the guide no
  // longer says Omit: it mandates per-model effort. The pi runtime still omits
  // effort unless manually overridden.
  assert.match(modelGuide, /Pass `effort` with the model/);
  assert.match(piRuntime, /Omit `effort` unless you need a manual override/);
  assert.match(modelGuide, /Never pass a category, task type, or `subagent_type`/);
  assert.match(piRuntime, /team_send/);
  assert.match(piRuntime, /`team_create` takes the approved team specification and does not accept Agent `model`, `preset`, or `effort` parameters/);
  assert.doesNotMatch(piRuntime, /from the rubato-pi adapter/);
});

test("role prompts delegate provider resolution and fallback to the harness", () => {
  // 785f6a3f9 moved the harness sentence out of the role fragments: roles point
  // at Skill(model-guide), and the guide names the harness. Guard the chain.
  const modelGuide = readFileSync(join(promptSourceRoot, "../skills/model-guide/SKILL.md"), "utf8");
  assert.match(modelGuide, /The harness resolves a named `preset` against the live catalog/);
  for (const role of ["lead", "owner"]) {
    const text = rolePrompt(role);
    assert.match(text, /with Skill\(model-guide\)/);
    assert.doesNotMatch(text, /Copy the model id from the live catalog/);
    assert.doesNotMatch(text, /to `Agent` or `team_create`/);
  }
});

test("shared prompt routes Aside and Outpost by the quality bottleneck", () => {
  for (const role of ["lead", "owner"]) {
    const text = rolePrompt(role);
    assert.match(text, /write down what you want to know and which part of the code counts/);
  }
  for (const role of ["lead", "owner", "verifier", "agent"]) {
    const text = rolePrompt(role);
    assert.match(text, /Route research by its bottleneck/);
    // "recall" dropped from the role prompt in 785f6a3f9; Skill(aside-browser)
    // still lists breadth, recall, freshness. Pin the prompt's current shape.
    assert.match(text, /breadth, freshness, or browser interaction to Aside/);
    assert.match(text, /reasoning depth to Outpost/);
    assert.match(text, /Aside gathers and Outpost analyzes/);
    assert.doesNotMatch(text, /Aside .* is the default route/);
    assert.doesNotMatch(text, /current external evidence, unfamiliar-domain research/);
  }
});

test("shared prompt carries the keep-simple invariant directly", () => {
  for (const role of ["lead", "owner", "verifier", "agent"]) {
    const text = rolePrompt(role);
    // 785f6a3f9 folded the keep-simple sentences into the cause-first paragraph.
    assert.match(text, /Size the change to that cause, no wider/);
    assert.match(text, /keep safety, validation, meaningful errors, tests, and explicit requirements while simplifying/);
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
