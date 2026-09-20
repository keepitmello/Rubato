import test from 'node:test';
import assert from 'node:assert/strict';
import { controlCommandFor, rewriteSkillMentions, surfaceFromPiCommands } from '../src/commands.mjs';

test('catalogue commands become T3 slash commands and skills; TUI duplicates stay out', () => {
  const surface = surfaceFromPiCommands([
    { name: 'audit', description: 'Run an audit', source: 'extension' },
    { name: 'draft', description: 'Draft a note', source: 'prompt' },
    { name: 'skill:ship-it', description: 'Ship the change', source: 'skill', sourceInfo: { path: '/tmp/ship-it/SKILL.md', scope: 'user' } },
    { name: 'model', description: 'Should not appear', source: 'extension' },
    { name: 'fork', description: 'Should not appear', source: 'extension' },
    { name: 'compact', description: 'Extension compact is ours', source: 'extension' },
  ]);
  assert.deepEqual(surface.slashCommands.map((item) => item.name), ['compact', 'name', 'reload', 'audit', 'draft']);
  assert.equal(surface.slashCommands.find((item) => item.name === 'compact').description.includes('context'), true);
  assert.deepEqual(surface.skills, [{
    name: 'ship-it', path: '/tmp/ship-it/SKILL.md', enabled: true,
    description: 'Ship the change', shortDescription: 'Ship the change', scope: 'user', displayName: 'ship-it',
  }]);
  assert.deepEqual([...surface.skillNames], ['ship-it']);
});

test('a $skill chip becomes /skill:name; currency and unknown names stay prose', () => {
  const names = new Set(['ship-it', 'review']);
  assert.equal(rewriteSkillMentions('$ship-it the patch', names), '/skill:ship-it the patch');
  assert.equal(rewriteSkillMentions('please $review this', names), 'please /skill:review this');
  assert.equal(rewriteSkillMentions('$review then $ship-it please', names), '/skill:review then /skill:ship-it please');
  assert.equal(rewriteSkillMentions('echo $HOME then $unknown', names), 'echo $HOME then $unknown');
  assert.equal(rewriteSkillMentions('pay $20 tomorrow', names), 'pay $20 tomorrow');
});

test('typed control commands become RPC payloads instead of prompts', () => {
  assert.deepEqual(controlCommandFor('/compact'), { name: 'compact', args: '', rpc: { type: 'compact' } });
  assert.deepEqual(controlCommandFor('  /compact keep the plan  '), {
    name: 'compact', args: 'keep the plan', rpc: { type: 'compact', customInstructions: 'keep the plan' },
  });
  assert.deepEqual(controlCommandFor('/name Rewound'), {
    name: 'name', args: 'Rewound', rpc: { type: 'set_session_name', name: 'Rewound' },
  });
  assert.deepEqual(controlCommandFor('/reload'), { name: 'reload', args: '', rpc: { type: 'reload' } });
  assert.equal(controlCommandFor('/audit now'), undefined);
  assert.equal(controlCommandFor('not a command'), undefined);
  assert.throws(() => controlCommandFor('/name'), /cannot be empty/);
});
