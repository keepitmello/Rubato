// Exercise the actual bundled copy, not just the shared source implementation.
import '../skills/work-intent/tests/intent.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
test('Codex root routing and packaged skill preserve native ownership and approval', () => {
  const base = read('../instructions/base.md');
  assert.ok(base.indexOf('read the bundled `work-intent`') > base.indexOf('## Lead — main/root session only'));
  assert.match(base, /before\s+choosing the execution shape/i);
  assert.match(base, /obtain combined confirmation of the/);
  const lead = read('../skills/agent-taskforce/LEAD.md');
  assert.match(lead, /Resolve intent before staffing/);
  assert.match(lead, /confirmation of both intent and roster before forming the team/);
});
