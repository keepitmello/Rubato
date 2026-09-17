import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = new URL('../../../skills/dispatching/SKILL.md', import.meta.url);
const text = readFileSync(path, 'utf8');
const receiving = text.split('## The receiving end')[1].split('## Reuse the agent')[0];
const endings = text.split('## When it comes back empty')[1].split('## Account for')[0];

// Source contract checks, not live-agent behavior or a quality score.
test('routine omissions do not wait for the user to inspect a first render', () => {
  assert.match(receiving, /A first render\s+is not an automatic stop/);
  assert.match(receiving, /corrects inspectable omissions before returning/);
  assert.doesNotMatch(text, /the return contract also stops at the first rendered state|does not continue to a second implementation turn/);
});

test('explicit early previews still stop and do not grant integration', () => {
  assert.match(receiving, /explicit first-preview checkpoint or user stop still binds/);
  assert.match(receiving, /even if the candidate\s+has known gaps/);
  assert.match(receiving, /show the useful candidate promptly/);
  assert.match(receiving, /preview assignment does not authorize product integration/);
  assert.match(endings, /judgment-ready preview completes a preview\s+assignment/);
  assert.match(endings, /Budget, authority, observation limits and explicit checkpoints/);
});

test('evidence limits and optional improvements do not become mandatory loops', () => {
  assert.match(receiving, /Static frames do not prove full-speed\s+rhythm/);
  assert.match(receiving, /request only\s+the remaining observation/);
  assert.match(receiving, /optional improvement as a\s+required repair/);
  assert.match(receiving, /implementation\s+owner for correction and recheck of the changed result/);
  assert.match(receiving, /reviewer does not repair production code it will independently judge/);
  assert.match(receiving, /without duplicating the owner's technical checks/);
  assert.match(endings, /grants no new installation or environment-rebuild authority/);
});

test('method freedom preserves delegated decisions and source-backed boundaries', () => {
  assert.match(text, /already-delegated tradeoffs/);
  assert.match(text, /before applying it broadly/);
  assert.match(text, /Provisional: owner-chosen methods, sequence, candidate counts/);
  assert.match(text, /prior failures with their conditions/);
  assert.match(text, /not technique bans/);
  for (const phrase of ['Frozen items touched: none', 'Frozen items: list unavailable',
    'read scope apart from write scope', 'self-report, not evidence', 'delta confirmation']) {
    assert.ok(text.includes(phrase), phrase);
  }
});
