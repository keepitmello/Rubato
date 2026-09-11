// Structural regression checks. These do not measure a live model's skill selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = p => readFileSync(path.join(root, p), 'utf8');
const flatten = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
  ? flatten(path.join(dir,e.name)) : [path.join(dir,e.name)]).sort();

test('both system prompts load taskforce at candidate stage and keep small work inline', () => {
  for (const p of ['harness/prompts/core-lead.pi.md','rubato-codex/instructions/base.md']) {
    const s=read(p); assert.match(s,/before\s+choosing the execution shape/i);
    assert.match(s,/work-intent/); assert.match(s,/Small local work stays in context/);
    assert.match(s,/missing from\s+discovery|absent from discovery/);
  }
});
test('Pi and Codex require the same combined intent/roster confirmation', () => {
  for (const p of [
    'harness/skills/agent-taskforce/LEAD.md',
    'rubato-codex/skills/agent-taskforce/LEAD.md',
    'harness/skills/agent-taskforce/references/01-operating-model.md',
    'rubato-codex/skills/agent-taskforce/references/01-operating-model.md',
  ]) {
    assert.match(read(p), /confirmation of both intent and roster/);
    assert.doesNotMatch(read(p), /notice[^\n]*veto|human veto|team in the same turn/);
  }
  assert.match(read('harness/skills/agent-taskforce/runtimes/pi.md'), /combined intent\/roster confirmation/);
});
test('both taskforce editions resolve intent before the roster and carry exact references', () => {
  for (const edition of ['harness','rubato-codex']) {
    const s=read(edition+'/skills/agent-taskforce/LEAD.md');
    const staff=edition==='harness' ? s.indexOf('## 3. Confirm intent and roster') : s.indexOf('Before staffing, read the Codex adapter');
    assert.ok(s.indexOf('## Resolve intent before staffing')<staff);
    assert.match(s,/actual human instruction/);
    assert.match(read(edition+'/skills/agent-taskforce/templates/task-brief.md'),/canonical workspace/);
    assert.match(read(edition+'/skills/dispatching/SKILL.md'),/intent_ref/);
    assert.match(read(edition+'/skills/dispatched/SKILL.md'),/Preserve the intent reference/);
  }
});
test('mission owns execution slice, not another global requirement list', () => {
  for (const edition of ['harness','rubato-codex']) {
    const s=read(edition+'/skills/agent-taskforce/templates/mission.md');
    assert.match(s,/Execution slice and acceptance links/);
    assert.match(s,/Shared runtime resources/);
    assert.match(s,/Resume point/);
    assert.doesNotMatch(s,/^## (Execution outcome|Scope, non-goals, constraints)$/m);
  }
});
test('managed work-intent and receiving contracts are byte-identical in the Codex bundle', () => {
  const dir=path.join(root,'harness/skills/work-intent');
  const sources=flatten(dir).map(p=>path.relative(dir,p));
  const dest=path.join(root,'rubato-codex/skills/work-intent');
  assert.deepEqual(flatten(dest).map(p=>path.relative(dest,p)),sources);
  for(const p of sources) assert.equal(read('harness/skills/work-intent/'+p),read('rubato-codex/skills/work-intent/'+p),p);
  assert.equal(read('harness/skills/dispatched/SKILL.md'),read('rubato-codex/skills/dispatched/SKILL.md'));
  const manifest=JSON.parse(read('rubato-codex/skill-bundle.json'));
  assert.equal(manifest.managed.filter(x=>x==='work-intent').length,1);
  assert.ok(manifest.preserved.includes('agent-taskforce'));
  assert.ok(manifest.preserved.includes('dispatching'));
});
test('generated owner/verifier/helper roles actually contain the receiving change', () => {
  for(const role of ['owner','verifier','helper']) {
    const s=read(`rubato-codex/agents/taskforce_${role}.toml`);
    assert.match(s,/Preserve the intent reference/);
    assert.match(s,/canonical workspace/);
    assert.doesNotMatch(s,/^model\s*=/m);
  }
});
test('board guide uses existing metadata without pretending task_update can edit it', () => {
  const s=read('rubato-codex/skills/agent-taskforce/runtimes/codex-taskforce.md');
  assert.match(s,/does not edit metadata/);
  assert.match(s,/does not enforce intent acceptance/);
});
test('intent policy preserves external authority, framing and actual delivery permissions', () => {
  const s=read('harness/skills/work-intent/SKILL.md');
  assert.match(s,/existing system of record/);
  assert.match(s,/FRAME_LOCK/);
  assert.match(s,/silence, or approval of only one part/);
  assert.match(s,/never stages, commits/);
  assert.match(s,/does not intercept runtime tools/);
});

test('team-create description advertises the read/intent sequence without pretending enforcement', () => {
  const s=read('packages/senpi-task/src/tools/team/lifecycle.ts');
  assert.match(s,/before choosing the execution shape/i);
  assert.match(s,/resolve the intent/);
  assert.match(s,/does not load skills/);
});


test('lead prompts gather facts and recommend before seeking human choices', () => {
  for (const p of ['harness/prompts/core-lead.pi.md', 'rubato-codex/instructions/base.md']) {
    const s = read(p);
    assert.match(s, /Gather discoverable\s+facts/);
    assert.match(s, /current primary\s+web sources/);
    assert.match(s, /Recommend a direction/);
    assert.match(s, /not an interview/);
    assert.match(s, /Same-owner follow-ups inside approval stay autonomous/);
  }
});

test('owners and verifiers are teammates who run subagents, not lead workers', () => {
  const teammate = read('harness/prompts/core-teammate.pi.md');
  assert.match(teammate, /with the lead and the other teammates/);
  assert.match(teammate, /you are not the lead's worker/);
  assert.match(teammate, /Delegate by cost, not by count/);
  assert.doesNotMatch(teammate, /may spawn `Agent` agents directly/);
  assert.doesNotMatch(teammate, /Run this scope the way the lead runs the team/);
  const lead = read('harness/prompts/core-lead.pi.md');
  assert.match(lead, /they are teammates, not your workers/);
  assert.match(lead, /subagents sit under whoever spawned them and are not on the team/);
  const agent = read('harness/prompts/core-agent.pi.md');
  assert.match(agent, /subagent of the session that sent this brief — the lead or a teammate/);
  const owner = read('harness/skills/agent-taskforce/teammate/workstream-owner.md');
  assert.match(owner, /Delegate by cost, not by count/);
  assert.doesNotMatch(owner, /You can run helpers under yourself/);
  // Seat identity is owned by the prompt pieces; skill docs and role contracts do not restate it.
  for (const file of ['harness/prompts/core-lead.pi.md', 'harness/prompts/core-teammate.pi.md', 'harness/prompts/core-agent.pi.md',
    'harness/skills/agent-taskforce/LEAD.md', 'harness/skills/agent-taskforce/TEAMMATE.md',
    'harness/skills/agent-taskforce/teammate/workstream-owner.md', 'harness/skills/agent-taskforce/teammate/independent-verifier.md']) {
    assert.doesNotMatch(read(file), /cognitively depth 0|Do not do this outcome as a subagent of the lead/, file);
  }
  for (const file of ['harness/skills/agent-taskforce/LEAD.md', 'harness/skills/agent-taskforce/TEAMMATE.md',
    'harness/skills/agent-taskforce/teammate/workstream-owner.md', 'harness/skills/agent-taskforce/teammate/independent-verifier.md']) {
    assert.doesNotMatch(read(file), /not the lead's worker|not your workers/, file);
  }
});

test('alignment distinguishes access gaps, local judgment and human decisions with a stopping rule', () => {
  const s = read('harness/skills/work-intent/references/alignment.md');
  for (const pattern of [/Discoverable fact/, /Local implementation judgment/, /Human preference/,
    /unavailable access/i, /Stop when you have enough evidence/, /recommendation/,
    /not a ban on necessary\s+communication/]) assert.match(s, pattern);
  assert.doesNotMatch(s, /ask (three|five|ten) questions/i);
});

test('combined confirmation keeps partial acceptance and accepted corrections distinct', () => {
  const s = read('harness/skills/work-intent/SKILL.md');
  assert.match(s, /Partial approval preserves what/);
  assert.match(s, /do not demand a ceremonial\nsecond yes/);
  assert.match(s, /already active intent stays active when unchanged/);
  assert.match(s, /same human|human reply|reply approving/);
  assert.match(s, /proposal message/);
  assert.match(s, /exact intent revision|intent revision it covered/);
});

test('approval message is user-readable and is not a new per-run document', () => {
  const s = read('harness/skills/work-intent/templates/approval-message.md');
  assert.match(s, /not a new\nfile to create per run/);
  assert.match(s, /이 작업 방향과 팀 구성으로 진행해도 될까/);
  assert.match(s, /fictional findings.*actual evidence/s);
  const quotes = s.split('\n').filter(line => line.startsWith('>')).join('\n');
  assert.doesNotMatch(quotes, /SSOT|intent_ref|FRAME_LOCK|workstream|Owner|Verifier|xhigh/);
});

test('draft discovery has an explicit non-implementation exception in receiving and dispatching', () => {
  for (const ed of ['harness', 'rubato-codex']) {
    assert.match(read(ed+'/skills/dispatched/SKILL.md'), /explicitly discovery-only/);
    assert.match(read(ed+'/skills/dispatched/SKILL.md'), /without\n`--active`/);
    assert.match(read(ed+'/skills/dispatched/SKILL.md'), /stop before implementation/);
    assert.match(read(ed+'/skills/dispatching/SKILL.md'), /Do not relabel execution owners as subagents/);
  }
  for (const role of ['owner', 'verifier', 'helper']) {
    assert.match(read(`rubato-codex/agents/taskforce_${role}.toml`), /explicitly discovery-only/);
  }
});

test('mission recovers a concrete proposal and a reply without copying intent requirements', () => {
  for (const ed of ['harness', 'rubato-codex']) {
    const s = read(ed+'/skills/agent-taskforce/templates/mission.md');
    assert.match(s, /Combined proposal message/);
    assert.match(s, /Combined confirmation/);
    assert.match(s, /Roster acceptance reference/);
    assert.match(s, /exact proposed model\/effort/);
    assert.doesNotMatch(s, /Roster notice|## Reported roster/);
  }
});

test('historical regression scenarios now expect combined approval without losing other protections', () => {
  const s = read('harness/skills/agent-taskforce/references/09-regression-scenarios.md');
  assert.match(s, /combined-intent-roster-confirmation/);
  assert.doesNotMatch(s, /roster-notice-and-veto|roster notice 후 사용자 veto/);
  for (const key of ['refutation-recall', 'pattern-kill-in-shared-space',
    'completion-honesty', 'root-cause-owner-continuity', 'true-frame-conflict']) assert.ok(s.includes(key));
});
