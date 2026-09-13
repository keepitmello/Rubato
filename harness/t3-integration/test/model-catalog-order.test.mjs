import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogForPicker, modelPickerLabel } from '../src/model-catalog-order.mjs';

test('T3 catalogue matches /model provider order, labels, and filter', () => {
  const models = [
    { provider: 'xai', id: 'grok-4.6', name: 'Grok 4.6' },
    { provider: 'anthropic', id: 'claude-opus-5', name: 'Claude Opus 5' },
    { provider: 'anthropic', id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
    { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { provider: 'cursor', id: 'cursor-grok-4.6', name: 'Grok 4.6' },
    { provider: 'unknown-lab', id: 'secret', name: 'Secret' },
  ];
  const catalog = catalogForPicker(models);
  assert.deepEqual(catalog.map((item) => `${item.provider}/${item.id}`), [
    'openai-codex/gpt-5.6-sol',
    'anthropic/claude-fable-5-1',
    'anthropic/claude-opus-5',
    'xai/grok-4.6',
    'cursor/cursor-grok-4.6',
  ]);
  assert.equal(modelPickerLabel(catalog[1]), 'Fable 5.1');
  assert.equal(modelPickerLabel(catalog[4]), 'grok-4.6-fast');
});
