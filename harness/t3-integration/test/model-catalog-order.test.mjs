import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_ORDER,
  applySelectionOptions,
  catalogForPicker,
  catalogSlugs,
  modelPickerLabel,
  modelSupportsFast,
  optionDescriptorsFor,
} from '../src/model-catalog-order.mjs';

test('T3 catalogue keeps the curated /model set and drops provider extras', () => {
  // 현재 세대 anthropic 행은 카탈로그가 소유한다. 여기서 손으로 적으면 세대가 바뀔 때마다
  // 이 테스트가 먼저 깨지고, 깨진 자리를 다시 베끼는 것 말고는 하는 일이 없어진다.
  const [fable, opus] = MODEL_ORDER.anthropic;
  const models = [
    { provider: 'xai', id: 'grok-4.7', name: 'Grok 4.7', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' }, api: 'openai-completions' },
    { provider: 'anthropic', id: opus, name: 'Claude Opus', reasoning: true, api: 'anthropic-messages' },
    { provider: 'anthropic', id: fable, name: 'Claude Fable', reasoning: true, thinkingLevelMap: { max: 'max' } },
    { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true },
    { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' }, api: 'openai-codex-responses' },
    { provider: 'openai-codex', id: 'gpt-daybreak-blue-latest-fast', name: 'Daybreak Blue Fast', api: 'openai-codex-responses' },
    { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4', reasoning: true, api: 'openai-codex-responses' },
    { provider: 'cursor', id: 'grok-4.7', name: 'Grok 4.7' },
    { provider: 'cursor', id: 'grok-4.7-high-fast', name: 'Grok 4.7 High Fast' },
    { provider: 'unknown-lab', id: 'secret', name: 'Secret' },
  ];
  const catalog = catalogForPicker(models);
  assert.deepEqual(catalog.map((item) => `${item.provider}/${item.id}`), [
    'openai-codex/gpt-5.6-sol',
    `anthropic/${fable}`,
    `anthropic/${opus}`,
    'xai/grok-4.7',
    'cursor/grok-4.7',
  ]);
  assert.equal(modelPickerLabel(catalog[1]), 'Fable 5.1');
  assert.equal(modelPickerLabel(catalog[3]), 'Grok 4.7');
  assert.equal(modelPickerLabel(catalog[4]), 'Grok 4.7 fast');
  // 첫 여섯은 Codex 다섯 + anthropic 첫 행이다 — provider 경계가 계약이다.
  assert.deepEqual(catalogSlugs().slice(0, 6), [
    'openai-codex/gpt-5.6-sol',
    'openai-codex/gpt-5.6-terra',
    'openai-codex/gpt-5.6-luna',
    'openai-codex/gpt-6-astra',
    'openai-codex/gpt-daybreak-blue-latest',
    `anthropic/${MODEL_ORDER.anthropic[0]}`,
  ]);
});

test('T3 catalogue keeps the current model even when it is outside the curated set', () => {
  const models = [
    { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
    { provider: 'xai', id: 'grok-4.7', name: 'Grok 4.7' },
  ];
  const catalog = catalogForPicker(models, { provider: 'openai-codex', id: 'gpt-5.4' });
  assert.deepEqual(catalog.map((item) => `${item.provider}/${item.id}`), [
    'openai-codex/gpt-5.4',
    'xai/grok-4.7',
  ]);
});

test('reasoning models expose effort, and fast-capable models expose Fast', () => {
  const sol = optionDescriptorsFor({
    provider: 'openai-codex',
    id: 'gpt-5.6-sol',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    api: 'openai-codex-responses',
  });
  assert.deepEqual(sol.optionDescriptors.map((item) => item.id), ['reasoningEffort', 'fastMode']);
  assert.deepEqual(sol.optionDescriptors[0].options.map((item) => item.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(sol.optionDescriptors[0].currentValue, 'medium');
  assert.equal(sol.optionDescriptors[1].type, 'boolean');

  const fable = optionDescriptorsFor({
    provider: 'anthropic',
    id: 'claude-fable-5-1',
    reasoning: true,
    thinkingLevelMap: { max: 'max' },
  });
  assert.deepEqual(fable.optionDescriptors.map((item) => item.id), ['reasoningEffort']);
  assert.equal(modelSupportsFast({ provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages' }), true);
  assert.equal(modelSupportsFast({ provider: 'anthropic', id: 'claude-fable-5-1', api: 'anthropic-messages' }), false);
});

test('T3 catalogue shows Anthropic account copies next to the base model', () => {
  const [fable, opus] = MODEL_ORDER.anthropic;
  const catalog = catalogForPicker([
    { provider: 'anthropic', id: opus, name: 'Claude Opus', reasoning: true, api: 'anthropic-messages' },
    { provider: 'anthropic', id: `${opus}-sub`, name: 'Claude Opus [sub]', reasoning: true, api: 'anthropic-messages' },
    { provider: 'anthropic', id: fable, name: 'Claude Fable', reasoning: true, thinkingLevelMap: { max: 'max' } },
    { provider: 'anthropic', id: `${fable}-sub`, name: 'Claude Fable [sub]', reasoning: true, thinkingLevelMap: { max: 'max' } },
  ]);
  assert.deepEqual(catalog.map((item) => `${item.provider}/${item.id}`), [
    `anthropic/${fable}`,
    `anthropic/${fable}-sub`,
    `anthropic/${opus}`,
    `anthropic/${opus}-sub`,
  ]);
  assert.equal(modelPickerLabel(catalog[0]), 'Fable 5.1');
  assert.equal(modelPickerLabel(catalog[1]), 'Fable 5.1 [sub]');
  assert.equal(modelPickerLabel(catalog[2]), 'Opus 5.5');
  assert.equal(modelPickerLabel(catalog[3]), 'Opus 5.5 [sub]');
  assert.equal(modelSupportsFast({ provider: 'anthropic', id: `${opus}-sub`, api: 'anthropic-messages' }), true);
});

test('selection options map T3 TraitsPicker ids onto Pi thinking and /fast', () => {
  assert.deepEqual(applySelectionOptions([
    { id: 'reasoningEffort', value: 'xhigh' },
    { id: 'fastMode', value: true },
  ]), { thinking: 'xhigh', fast: true });
  assert.deepEqual(applySelectionOptions([{ id: 'thinking', value: 'high' }]), { thinking: 'high', fast: undefined });
  assert.deepEqual(applySelectionOptions([{ id: 'serviceTier', value: 'priority' }]), { thinking: undefined, fast: true });
  assert.throws(() => applySelectionOptions([{ id: 'unknown', value: 'x' }]), /Unsupported Pi option/);
});

test('T3 catalogue never lists the OpenAI API provider, even as the current model', () => {
  const models = [
    { provider: 'openai', id: 'gpt-6-astra', name: 'GPT-6 Astra', api: 'openai-responses' },
    { provider: 'openai-codex', id: 'gpt-6-astra', name: 'GPT-6 Astra', api: 'openai-codex-responses' },
    { provider: 'xai', id: 'grok-4.7', name: 'Grok 4.7' },
  ];
  const catalog = catalogForPicker(models, { provider: 'openai', id: 'gpt-6-astra' });
  assert.deepEqual(catalog.map((item) => `${item.provider}/${item.id}`), [
    'openai-codex/gpt-6-astra',
    'xai/grok-4.7',
  ]);
});
