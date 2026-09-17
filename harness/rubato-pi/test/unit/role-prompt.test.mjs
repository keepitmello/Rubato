import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assignedRoleSection, loadRolePrompt, promptNameForRole, replaceSystemPrompt,
} from "../../src/system-prompt.mjs";
import { createPromptFixture, promptSourceRoot } from "../helpers/prompt-fixture.mjs";

const fixture = createPromptFixture();
after(() => fixture.dispose());
const source = (file) => readFileSync(join(promptSourceRoot, file), "utf8");
const skill = (file) => readFileSync(join(promptSourceRoot, "../skills", file), "utf8");
const built = (role) => loadRolePrompt(role, { env: fixture.env });
const composed = (role, existing = "") => replaceSystemPrompt(existing, role, {
  env: fixture.env, argv: [], skillsSection: () => "",
});
const allRoles = ["lead", "owner", "verifier", "agent"];

// Static contracts guard source/build consistency. They are not live-model
// behavior tests and do not prove that the new policy costs less in production.

test("roles share only the intended source fragments and preserve voice", () => {
  const voice = source("voice.md").trim();
  const cases = [
    ["lead", ["base.pi.md", "brief-exchange.pi.md", "core-lead.pi.md"]],
    ["owner", ["base.pi.md", "brief-exchange.pi.md", "core-teammate.pi.md"]],
    ["verifier", ["base.pi.md", "brief-exchange.pi.md", "core-teammate.pi.md"]],
    ["agent", ["base.pi.md", "core-agent.pi.md"]],
  ];
  for (const [role, fragments] of cases) {
    for (const fragment of fragments) assert.ok(built(role).includes(source(fragment).trim()));
    assert.ok(built(role).trim().endsWith(voice));
  }
  assert.equal(promptNameForRole("owner"), promptNameForRole("verifier"));
  assert.equal(built("owner"), built("verifier"));
  assert.notEqual(composed("owner"), composed("verifier"));
});

test("the lead starts from the user conversation", () => {
  const text = source("core-lead.pi.md");
  assert.match(text, /^# Lead/m);
  assert.match(text, /Your role is the conversation/);
  assert.match(text, /frame the problem with the user/);
  assert.match(text, /changed goal or commitment goes back to the user/);
});

test("the user sees the lead's reading before work, with or without a team", () => {
  const text = source("core-lead.pi.md");
  assert.match(text, /Before anything beyond small local work, the user sees your reading/);
  assert.match(text, /what you will change, what stays, how you will check it/);
  assert.match(text, /propose intent and roster together/);
  assert.match(text, /form the team only on explicit confirmation of both/);
  assert.doesNotMatch(text, /precise current instruction can already authorize/);
});

test("technical certification stays with owners and verifiers", () => {
  const lead = source("core-lead.pi.md");
  assert.match(lead, /Accept results on the owner's evidence/);
  assert.match(lead, /technical certification belongs to owners and verifiers/);
  assert.match(skill("agent-taskforce/LEAD.md"), /fulfillment decision, not technical/);
  assert.match(skill("agent-taskforce/references/01-operating-model.md"), /Named integration owner/);
});

test("common teammate contract supports both owner and verifier", () => {
  const text = source("core-teammate.pi.md");
  assert.match(text, /# Teammate/);
  assert.doesNotMatch(text, /^# Workstream owner/m);
  assert.match(text, /sharing this prompt does not make a verifier an implementer/);
  assert.match(text, /workstream-owner for an owner, independent-verifier for a verifier/);
  assert.match(composed("verifier"), /Role: verifier/);
  assert.match(composed("verifier"), /Do not implement the production change you will judge/);
  assert.match(composed("owner"), /Role: owner/);
});

test("helpers retain bounded judgment without acquiring the wider outcome", () => {
  assert.match(source("core-agent.pi.md"), /Use judgment inside that assignment/);
  assert.match(source("core-agent.pi.md"), /not a command to stop thinking/);
  assert.match(source("core-agent.pi.md"), /Keep the wider outcome/);
  assert.match(source("core-teammate.pi.md"), /Helpers may reason inside their boundary/);
  assert.match(source("core-teammate.pi.md"), /you retain the outcome/);
});

test("delegation policy lives in the dispatching skill, not the prompt", () => {
  const base = source("base.pi.md");
  assert.doesNotMatch(base, /Phase labels|difficulty score|AgentSend/);
  assert.match(source("core-lead.pi.md"), /Skill\(dispatching\)/);
  for (const file of ["core-lead.pi.md", "core-teammate.pi.md"]) {
    assert.doesNotMatch(source(file), /then dispatch a(?:n? agent| subagent) to map/);
    assert.doesNotMatch(source(file), /Build and judgment are separate dispatches/);
  }
});

test("a related assignment retains context; no forced narrow task conveyor", () => {
  const dispatch = skill("dispatching/SKILL.md");
  assert.match(dispatch, /send the next task to that agent/);
  assert.match(dispatch, /stronger model merely being available is not enough/);
  assert.match(dispatch, /explicit approved reassignment/);
});

test("budget return differs from completion and incapability", () => {
  for (const file of ["brief-exchange.pi.md", "core-agent.pi.md"]) {
    assert.match(source(file), /budget/i);
    assert.match(source(file), /valid return/);
  }
  assert.match(source("brief-exchange.pi.md"), /Returning is not mission acceptance/);
  assert.match(skill("dispatched/SKILL.md"), /completed dispatch, not a failure/);
  assert.match(skill("dispatching/SKILL.md"), /not proof of model incapability/);
  assert.match(skill("return/SKILL.md"), /A completed process is not mission acceptance/);
});

test("dispatching retains binding authority, freezes, first render and block recovery", () => {
  const text = skill("dispatching/SKILL.md");
  for (const phrase of [
    "The outcome and why it matters", "Done evidence", "Write ownership and off-limits paths",
    "Name a number", "Provisional:", "read scope apart from write scope",
    "Frozen items touched: none", "Frozen items: list unavailable",
    "self-report, not evidence", "stops at the first rendered state",
    "Recover the cause from the same session first", "nothing new appears",
  ]) assert.ok(text.includes(phrase), phrase);
  assert.match(text, /not elapsed time alone/);
  assert.match(text, /no.*retry count|Do not impose a retry count/);
});

test("approval is not broadened by role or model changes", () => {
  const guide = skill("model-guide/SKILL.md");
  assert.match(guide, /Fable \(including Fable 5\.1\), Sol and\nAstra require explicit user approval/);
  assert.match(guide, /outcome, model and effort/);
  assert.match(guide, /same approved owner on the same\noutcome retain that approval/);
  assert.match(guide, /new outcome, materially changed roster or higher/);
  assert.match(guide, /helper is not an approval bypass/);
  const lead = skill("agent-taskforce/LEAD.md");
  assert.match(lead, /explicit acceptance of both intent and roster/);
  assert.match(lead, /actual human reply/);
  assert.match(lead, /Partial|partial/);
});

test("all five models are ordinary owner and verifier candidates", () => {
  const guide = skill("model-guide/SKILL.md");
  assert.match(guide, /Fable, Astra, Opus, Sol and Grok may fill either role/);
  assert.match(guide, /initial assignments|Initial assignments/);
  assert.doesNotMatch(guide, /Opus 5 has no slot/);
  assert.doesNotMatch(guide, /a Grok owner is itself the bottleneck/);
  assert.doesNotMatch(guide, /same effort and approval rule as Fable and Sol/);
  assert.match(guide, /Acceptance criteria stay the same/);
  assert.match(guide, /not a quota of model names inside each team/);
});

test("model selection preserves configured effort and exact runtime identity", () => {
  const guide = skill("model-guide/SKILL.md");
  assert.match(guide, /Omit `effort` normally/);
  assert.match(guide, /configured model default/);
  assert.match(guide, /Preserve explicit\nuser settings/);
  assert.match(guide, /exact `model`/);
  assert.match(guide, /named `preset`/);
  assert.match(guide, /never a category, task type, or `subagent_type`/);
  assert.match(guide, /does not create another effort-precedence rule/);
  assert.match(guide, /requested settings separately/);
  assert.match(guide, /unavailable models fail visibly/);
  assert.match(guide, /harness resolves a named preset/);
});

test("resource reports do not become live quota or universal aptitude claims", () => {
  const guide = skill("model-guide/SKILL.md");
  assert.match(guide, /operator-reported starting priors/);
  assert.match(guide, /not measured/);
  assert.match(guide, /Token volume, API-equivalent dollars, elapsed time and subscription quota are/);
  assert.match(guide, /not.*live plan coefficients|live plan coefficients/);
  assert.match(guide, /Do not hard-code those as prices/);
  assert.match(guide, /No new router agent/);
});

test("fresh same-family verification is allowed but self-certification is not", () => {
  const verifier = skill("agent-taskforce/teammate/independent-verifier.md");
  assert.match(verifier, /model family may be the same/);
  assert.match(verifier, /Sharing the\nteammate prompt with owners does not authorize/);
  assert.match(verifier, /do not.*repair|does not authorize you to repair/);
  assert.match(verifier, /do not|Do not/);
  const guide = skill("model-guide/SKILL.md");
  assert.match(guide, /same family in a separate session/);
  assert.match(guide, /Never let the actual builder certify its own work as/);
  assert.match(guide, /not automatically waste or an automatic/);
  assert.match(guide, /Do not use a fixed call count/);
});

test("verification is not recursively duplicated across roles", () => {
  assert.match(source("core-teammate.pi.md"), /existing verifier rather than spawning another/);
  assert.match(source("core-teammate.pi.md"), /does not recursively commission another verifier/);
  assert.match(skill("agent-taskforce/teammate/independent-verifier.md"), /Do not\nspawn another verifier merely/);
  assert.match(skill("agent-taskforce/references/06-quality-and-evals.md"), /does not repeat a full technical pass/);
});

test("criterion, instrument validity and intermittent sampling remain explicit", () => {
  const verifier = skill("agent-taskforce/teammate/independent-verifier.md");
  for (const phrase of [
    "Two falsification targets", "measurement-invalid", "Known failures must",
    "known successes must pass", "Stop the sweep", "raw evidence",
    "sample size", "sampling assumptions", "correlated runs",
    "Send reproducible failures directly", "terminal scrollback",
  ]) assert.ok(verifier.includes(phrase), phrase);
  assert.match(verifier, /Finding nothing is a valid/);
  assert.match(verifier, /Do not create blockers/);
});

test("intent reference and frame authority survive delegation", () => {
  const text = skill("dispatched/SKILL.md");
  for (const phrase of ["intent_ref", "SHA-256", "canonical workspace",
    "discovery-only", "draft", "active status", "same session", "questionnaire"]) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.match(skill("agent-taskforce/TEAMMATE.md"), /cannot silently overwrite the user's freeze/);
  assert.match(skill("agent-taskforce/teammate/workstream-owner.md"), /Never modify an active FRAME_LOCK/);
  assert.match(skill("agent-taskforce/references/01-operating-model.md"), /Never write the same file concurrently/);
});

test("scope boundaries and the closing reply remain common", () => {
  const text = source("base.pi.md");
  assert.match(text, /^You are an agent working at Rubato/m);
  for (const phrase of ["Answer from what you inspected", "ask before anything hard to reverse",
    "Fix the cause in the project's existing pattern",
    "what changed, what you verified, what remains"]) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.doesNotMatch(text, /—/);
  for (const role of allRoles) assert.ok(built(role).includes(text.trim()));
});

test("Pi tools, support and teammate axes do not import another runtime", () => {
  const lead = source("core-lead.pi.md");
  assert.match(lead, /`Agent`/);
  assert.match(lead, /Skill\(model-guide\)/);
  assert.doesNotMatch(lead, /cs-agent/);
  assert.match(source("core-teammate.pi.md"), /`Agent`/);
  assert.match(source("core-teammate.pi.md"), /`team_send`/);
  const runtime = skill("agent-taskforce/runtimes/pi.md");
  assert.match(runtime, /kind: owner\|verifier/);
  assert.match(runtime, /plus optional `effort`/);
  assert.match(runtime, /never declared as a member/);
  for (const role of allRoles) {
    assert.doesNotMatch(built(role), /FX_SUBAGENT_SYSTEM_PROMPT_FILE|## Rails — fx|\.fx\//);
  }
});

test("research and memory routes remain available, not compulsory phases", () => {
  const text = source("base.pi.md");
  for (const phrase of ["msearch", "Skill(aside-browser)", "Skill(outpost)", "cite links", "runtime check"]) {
    assert.ok(text.includes(phrase), phrase);
  }
});

test("runtime assignment is stable, specific, idempotent and independent of model tier", () => {
  for (const role of allRoles) {
    const first = composed(role, "<project_context>keep</project_context>\nCurrent working directory: /tmp/work");
    assert.match(first, new RegExp(`Role: ${role}\\b`));
    assert.match(first, /<project_context>keep/);
    assert.equal((first.match(/## Runtime-assigned role/g) ?? []).length, 1);
    assert.equal(composed(role, first), first);
  }
  assert.equal(assignedRoleSection("unknown"), "");
  assert.equal(assignedRoleSection("__proto__"), "");
  assert.equal(assignedRoleSection(undefined), "");
});
