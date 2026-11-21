import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// The composer's controls in v0.1.0's places (composer-layout-edits.mjs), read from an applied tree.
const applied = (relative) => readFile(path.join(process.env.T3_SOURCE, relative), 'utf8');
const skip = { skip: !process.env.T3_SOURCE };

test('model and access lead the row; speed, mic, call, attach, ring and send follow in that order', skip, async () => {
  const composer = await applied('apps/web/src/components/chat/ChatComposer.tsx');
  const footer = composer.slice(composer.lastIndexOf('data-chat-composer-footer="true"'));
  const at = (needle) => {
    const index = footer.indexOf(needle);
    assert.ok(index >= 0, `missing ${needle}`);
    return index;
  };
  const order = [
    '{composerControls}',
    'data-chat-composer-actions="right"',
    'data-rubato-speed-label',
    '<RubatoVoiceControl',
    '<RubatoCallComposerButton',
    '{composerAttachButton && !dictationTakesFooter ? composerAttachButton : null}',
    '<ContextWindowMeter',
    '<ComposerFooterPrimaryActions',
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(footer, /"relative flex min-w-0 flex-1 items-center justify-start gap-0\.5"/);
});

test('the access mode stays in the composer and the new-thread strip does not repeat it', skip, async () => {
  const bar = await applied('apps/web/src/components/chat/ComposerControlsBar.tsx');
  assert.match(bar, /matchesDefault: false,/);
  // The effort is its own button between the model and the access chip, not a model suffix.
  const model = bar.indexOf('{composerModelPicker}\n');
  const effort = bar.indexOf('<TraitsPicker\n', model);
  const access = bar.indexOf('restingBlockDefs.map(', model);
  assert.ok(model > 0 && model < effort && effort < access, 'model, effort, access in that order');
  assert.match(bar, /triggerSuffix=\{null\}/);
  assert.match(bar, /popupAlign="start"/);
  const view = await applied('apps/web/src/components/ChatView.tsx');
  assert.doesNotMatch(view, /<ComposerContextPermissions/);
});
