import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {mobileEdits, mobileOverlays} from '../mobile/index.mjs';
import {resolveRubatoGlyph} from '../overlay/apps/mobile/src/components/rubatoModelGlyph.ts';

test('every Rubato model draws its vendor, never T3\'s OpenAI fallback', () => {
  const models = ['anthropic/claude-opus-5-5', 'xai/grok-4.7', 'google-vertex/gemini-4-argon',
    'opengateway/deepseek/deepseek-v4.1-flash-eco', 'nanogpt/z-ai/glm-5.3-uncensored', 'cursor/kimi-k3', 'unknown/x'];
  for (const model of models)
    assert.notDeepEqual(resolveRubatoGlyph('rubato-pi', model), {kind: 'driver', driver: 'codex'}, model);
  assert.deepEqual(resolveRubatoGlyph('rubato-pi', 'openai-codex/gpt-6.1-sol'), {kind: 'driver', driver: 'codex'});
  assert.equal(resolveRubatoGlyph('claudeAgent', 'xai/grok-4.7'), null);
});

test('the iPhone app cuts T3\'s cloud and carries Rubato\'s name', async () => {
  const config = mobileEdits['apps/mobile/app.config.ts'].map(([, addition]) => addition).join('\n');
  for (const wanted of ['"com.keepitmello.rubato"', 'appleTeamId: "5WGZKZGPQS"', 'enabled: false', 'relay: { url: null }'])
    assert.ok(config.includes(wanted), wanted);
  const replaced = mobileEdits['apps/mobile/app.config.ts'].map(([anchor]) => anchor).join('\n');
  for (const removed of ['u.expo.dev', '@clerk/expo', 'pingdotgg', 'ARK85ZXQ4Z']) assert.ok(replaced.includes(removed), removed);
  for (const relative of mobileOverlays) await readFile(new URL(`../overlay/${relative}`, import.meta.url));
});

// apply.mjs undoes an edit by finding its addition; one already in the pin would be "undone" there.
test('mobile edits anchor once and add only new text at the pin', {skip: !process.env.T3_SOURCE}, async () => {
  const pin = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
  for (const [relative, changes] of Object.entries(mobileEdits)) {
    assert.ok(relative in pin.targets, `${relative} is missing from upstream.json`);
    const original = execFileSync('git', ['-C', process.env.T3_SOURCE, 'show', `${pin.upstreamCommit}:${relative}`], {encoding: 'utf8', maxBuffer: 1 << 28});
    for (const [anchor, addition, mode] of changes) {
      assert.equal(original.split(anchor).length, 2, `${relative}: ${anchor.slice(0, 60)}`);
      assert.ok(!original.includes(mode === 'replace' ? addition : addition + anchor), `${relative}: ${addition.slice(0, 60)}`);
    }
  }
});
