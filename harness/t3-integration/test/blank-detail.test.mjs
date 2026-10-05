import test from 'node:test';
import assert from 'node:assert/strict';
import { EventProjection } from '../src/events.mjs';

function projection() {
  const events = [];
  const p = new EventProjection({ threadId: 't', sessionId: 's', instanceId: 'rubato', emit: (e) => events.push(e),
    sessionMessage: () => {}, awaitedWakes: async () => ({ items: [] }), released: () => {} });
  return { p, events };
}
const assistant = (text, extra = {}) => ({ role: 'assistant', timestamp: 1, stopReason: 'toolUse',
  content: [{ type: 'text', text }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }], ...extra });
const completed = (events) => events.filter((e) => e.type === 'item.completed' && e.payload.itemType === 'assistant_message');

// T3 decodes `detail` as a trimmed non-empty string. An assistant message whose text is only
// whitespace (OpenGateway's DeepSeek sends "\n\n" beside a tool call) made the whole event
// undecodable, which failed startSession on every resume and failed Stop.
test('an assistant message with whitespace-only text carries no detail', () => {
  const { p, events } = projection();
  p.message(assistant('\n\n'), true);
  const done = completed(events);
  assert.equal(done.length, 1);
  assert.equal('detail' in done[0].payload, false);
});

test('whitespace-only thinking carries no detail either', () => {
  const { p, events } = projection();
  p.message({ role: 'assistant', timestamp: 2, stopReason: 'stop', content: [{ type: 'thinking', thinking: ' \n' }, { type: 'text', text: 'ok' }] }, true);
  for (const event of events) {
    if (typeof event.payload?.detail === 'string') assert.notEqual(event.payload.detail.trim(), '', event.type);
  }
});

test('real text keeps its detail exactly as it came', () => {
  const { p, events } = projection();
  p.message(assistant('Looking at the sidebar.\n'), true);
  assert.equal(completed(events)[0].payload.detail, 'Looking at the sidebar.\n');
});

test('streamed deltas keep their whitespace: only labels are dropped', () => {
  const { p, events } = projection();
  p.message(assistant('\n\n'), false);
  const delta = events.find((e) => e.type === 'content.delta');
  assert.equal(delta.payload.delta, '\n\n');
});
