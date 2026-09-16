// Structural contracts, not live-model skill-selection or quota measurements.
// Pi prose is maintained independently from the preserved Codex operating edition.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => readFileSync(path.join(root, p), "utf8");
const flatten = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? flatten(path.join(dir, e.name)) : [path.join(dir, e.name)]).sort();

test("Pi lead resolves intent and chooses shape before staffing", () => {
  const p = read("harness/prompts/core-lead.pi.md");
  assert.match(p, /primary role is the conversation with the user/);
  assert.match(p, /read Skill\(agent-taskforce\), LEAD.md and the active adapter before deciding/);
  assert.match(p, /work-intent/);
  assert.match(p, /no team helps/);
  assert.match(p, /Without a team, perform the authorized work directly/);
  assert.match(p, /explicit confirmation of both intent and roster/);
  assert.match(p, /The user-selected lead is independent of execution allocation/);
});

test("Pi combined approval preserves actual human assent, authority and continuity", () => {
  const s = read("harness/skills/agent-taskforce/LEAD.md");
  assert.match(s, /explicit acceptance of both intent and roster/);
  assert.match(s, /actual human reply/);
  assert.match(s, /reviewed intent revision/);
  assert.match(s, /partial approval/);
  assert.match(s, /bounded discovery agent/i);
  assert.match(s, /does not implement or become a continuing owner/);
  assert.match(s, /Preserve approved\nowners through corrections/);
  assert.match(s, /material restaffing/i);
  assert.match(s, /exact `intent_ref` and canonical workspace/);
  assert.match(read("harness/skills/agent-taskforce/templates/task-brief.md"), /canonical workspace/);
  assert.match(read("harness/skills/dispatching/SKILL.md"), /intent_ref/);
  assert.match(read("harness/skills/dispatched/SKILL.md"), /Preserve the intent reference/);
});

test("Pi mission links acceptance and assigns technical integration instead of duplicating intent", () => {
  const s = read("harness/skills/agent-taskforce/templates/mission.md");
  for (const phrase of ["Combined proposal", "Actual reply", "Requested model/effort",
    "Actual model/route", "Boundaries and technical integration", "Integration owner",
    "Shared resources", "Resume point", "Valid budget"]) assert.ok(s.includes(phrase), phrase);
  assert.match(s, /not another\nspecification/);
  assert.doesNotMatch(s, /^## (Execution outcome|Scope, non-goals, constraints)$/m);
});

test("Pi roles keep local reasoning, peer communication and user decisions distinct", () => {
  const teammate = read("harness/prompts/core-teammate.pi.md");
  assert.match(teammate, /not the lead's worker/);
  assert.match(teammate, /sharing this prompt does not make a verifier an implementer/);
  assert.match(teammate, /Helpers may reason inside their boundary/);
  assert.match(teammate, /`team_send` directly/);
  const owner = read("harness/skills/agent-taskforce/teammate/workstream-owner.md");
  assert.match(owner, /lead is not your debugger/);
  assert.match(owner, /coordinate peer inputs, implement the shared integration/);
  const agent = read("harness/prompts/core-agent.pi.md");
  assert.match(agent, /subagent of the session that sent this brief — the lead or a teammate/);
  assert.match(agent, /Keep the wider outcome/);
  for (const file of ["core-lead.pi.md", "core-teammate.pi.md", "core-agent.pi.md"]) {
    assert.doesNotMatch(read("harness/prompts/" + file),
      /cognitively depth 0|Do not do this outcome as a subagent of the lead/);
  }
});

test("Pi and Codex receiving boundaries retain draft discovery and no approval bypass", () => {
  for (const edition of ["harness", "rubato-codex"]) {
    const receiving = read(edition + "/skills/dispatched/SKILL.md");
    assert.match(receiving, /explicitly discovery-only/);
    assert.match(receiving, /without\n`--active`/);
    assert.match(receiving, /stop before implementation/);
    assert.match(read(edition + "/skills/dispatching/SKILL.md"),
      /Do not relabel execution owners as subagents/);
  }
});

test("unchanged managed intent and receiving sources still match the Codex bundle", () => {
  const dir = path.join(root, "harness/skills/work-intent");
  const dest = path.join(root, "rubato-codex/skills/work-intent");
  const sources = flatten(dir).map((p) => path.relative(dir, p));
  assert.deepEqual(flatten(dest).map((p) => path.relative(dest, p)), sources);
  for (const p of sources) {
    assert.equal(read("harness/skills/work-intent/" + p), read("rubato-codex/skills/work-intent/" + p), p);
  }
  assert.equal(read("harness/skills/dispatched/SKILL.md"), read("rubato-codex/skills/dispatched/SKILL.md"));
  const manifest = JSON.parse(read("rubato-codex/skill-bundle.json"));
  assert.equal(manifest.managed.filter((x) => x === "work-intent").length, 1);
  for (const name of ["agent-taskforce", "dispatching", "model-guide"]) assert.ok(manifest.preserved.includes(name));
});

test("Codex operating edition retains its own approval and native contracts", () => {
  // No Codex instructions or generated roles are regenerated by this Pi change.
  const p = read("rubato-codex/instructions/base.md");
  for (const pattern of [/before\s+choosing the execution shape/i,
    /Small local work stays in context/, /absent from discovery/,
    /Gather discoverable\s+facts/, /current primary\s+web sources/,
    /Recommend a direction/, /not an interview/, /Same-owner follow-ups inside approval stay autonomous/]) {
    assert.match(p, pattern);
  }
  const lead = read("rubato-codex/skills/agent-taskforce/LEAD.md");
  assert.match(lead, /confirmation of both intent and roster/);
  assert.match(lead, /actual human instruction/);
  assert.ok(lead.indexOf("## Resolve intent before staffing") < lead.indexOf("Before staffing, read the Codex adapter"));
  assert.match(read("rubato-codex/skills/agent-taskforce/references/01-operating-model.md"),
    /confirmation of both intent and roster/);
  const mission = read("rubato-codex/skills/agent-taskforce/templates/mission.md");
  for (const text of ["Execution slice and acceptance links", "Shared runtime resources",
    "Resume point", "Combined proposal message", "Combined confirmation",
    "Roster acceptance reference", "exact proposed model/effort"]) assert.ok(mission.includes(text), text);
  for (const role of ["owner", "verifier", "helper"]) {
    const s = read(`rubato-codex/agents/taskforce_${role}.toml`);
    assert.match(s, /Preserve the intent reference/);
    assert.match(s, /canonical workspace/);
    assert.match(s, /explicitly discovery-only/);
    assert.doesNotMatch(s, /^model\s*=/m);
  }
  const board = read("rubato-codex/skills/agent-taskforce/runtimes/codex-taskforce.md");
  assert.match(board, /does not edit metadata/);
  assert.match(board, /does not enforce intent acceptance/);
});

test("intent policy keeps external authority and partial approval separate from local methods", () => {
  const s = read("harness/skills/work-intent/SKILL.md");
  for (const pattern of [/existing system of record/, /FRAME_LOCK/,
    /silence, or approval of only one part/, /never stages, commits/,
    /does not intercept runtime tools/, /Partial approval preserves what/,
    /do not demand a ceremonial\nsecond yes/, /already active intent stays active when unchanged/,
    /same human|human reply|reply approving/, /proposal message/,
    /exact intent revision|intent revision it covered/]) assert.match(s, pattern);
  const alignment = read("harness/skills/work-intent/references/alignment.md");
  for (const pattern of [/Discoverable fact/, /Local implementation judgment/,
    /Human preference/, /unavailable access/i, /Stop when you have enough evidence/,
    /recommendation/, /not a ban on necessary\s+communication/]) assert.match(alignment, pattern);
  assert.doesNotMatch(alignment, /ask (three|five|ten) questions/i);
});

test("approval message remains readable and does not create another per-run document", () => {
  const s = read("harness/skills/work-intent/templates/approval-message.md");
  assert.match(s, /not a new\nfile to create per run/);
  assert.match(s, /이 작업 방향과 팀 구성으로 진행해도 될까/);
  assert.match(s, /fictional findings.*actual evidence/s);
  const quotes = s.split("\n").filter((line) => line.startsWith(">")).join("\n");
  assert.doesNotMatch(quotes, /SSOT|intent_ref|FRAME_LOCK|workstream|Owner|Verifier|xhigh/);
});

test("team-create tool describes sequence without pretending it enforces the whole policy", () => {
  const s = read("packages/senpi-task/src/tools/team/lifecycle.ts");
  assert.match(s, /before choosing the execution shape/i);
  assert.match(s, /resolve the intent/);
  assert.match(s, /does not load skills/);
});

test("historical regression cases are retained while role and allocation expectations change", () => {
  const s = read("harness/skills/agent-taskforce/references/09-regression-scenarios.md");
  for (const key of ["combined-intent-roster-confirmation", "refutation-recall",
    "pattern-kill-in-shared-space", "completion-honesty", "root-cause-owner-continuity",
    "true-frame-conflict", "reported-gate-is-a-claim", "no-standing-fable-teammate",
    "lead-conversation-is-primary", "integration-has-an-owner", "all-five-can-own",
    "budget-return-is-not-failure", "no-recursive-verification"]) assert.ok(s.includes(key), key);
  assert.doesNotMatch(s, /roster-notice-and-veto|roster notice 후 사용자 veto/);
});
