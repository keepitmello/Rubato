import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// Both composers (thread and new thread) with v0.1.0's arrangement (composer-layout-edits.mjs),
// read from an applied tree.
const applied = (relative) => readFile(path.join(process.env.T3_SOURCE, relative), 'utf8');
const skip = { skip: !process.env.T3_SOURCE };
// Each needle must occur after the previous one.
const order = (text, needles) => {
  let from = 0;
  for (const needle of needles) {
    const index = text.indexOf(needle, from);
    assert.ok(index >= 0, `missing ${needle} after offset ${from}`);
    from = index + needle.length;
  }
};

test('both composers: the model leads; speed, mic, call, attach, ring and send follow', skip, async () => {
  const composer = await applied('apps/web/src/components/chat/ChatComposer.tsx');
  const footer = composer.slice(composer.lastIndexOf('data-chat-composer-footer="true"'));
  // One arrangement for every route: no new-thread branch left in the row.
  assert.doesNotMatch(footer.slice(0, footer.indexOf('<ComposerFooterPrimaryActions')), /routeKind/);
  order(footer, [
    'justify-start gap-0.5',
    '{composerControls}',
    'data-chat-composer-actions="right"',
    'data-rubato-speed-label',
    '<RubatoVoiceControl',
    '<RubatoCallComposerButton',
    '{composerAttachButton && !dictationTakesFooter ? composerAttachButton : null}',
    '<ContextWindowMeter',
    '<ComposerFooterPrimaryActions',
  ]);
});

test('the control row keeps even insets, a model chip, one cluster and a divider (rubatoPolish.css)', async () => {
  const css = await readFile(new URL('../overlay/apps/web/src/rubatoPolish.css', import.meta.url), 'utf8');
  const row = css.slice(css.indexOf('[data-chat-composer-footer="true"] {'));
  assert.match(row, /^\[data-chat-composer-footer="true"\] \{\n  padding-inline-end: calc\(var\(--spacing\) \* 4\);\n  padding-bottom: calc\(var\(--spacing\) \* 4\);/);
  assert.match(row, /\[data-chat-provider-model-picker="true"\] \{\n  background-color: var\(--rb-hairline\);/);
  assert.match(row, /\[data-chat-composer-actions="right"\] button\.rounded-full \{\n  width: calc\(var\(--spacing\) \* 7\);/);
  assert.match(row, /\[data-rubato-speed-label\]::after \{[^}]*background: var\(--rb-hairline-strong\);/);
});

test('the model button keeps its effort; the picker opens from the left', skip, async () => {
  const bar = await applied('apps/web/src/components/chat/ComposerControlsBar.tsx');
  assert.match(bar, /popupAlign="start"/);
  assert.match(bar, /triggerSuffix=\{effort\.suffix\}/);
  assert.doesNotMatch(bar, /<TraitsPicker/);
});

test('the access mode shows nowhere: no chip, no new-thread strip control, no picker footer menu', skip, async () => {
  const bar = await applied('apps/web/src/components/chat/ComposerControlsBar.tsx');
  assert.match(bar, /matchesDefault: true,/);
  const strip = await applied('apps/web/src/components/ComposerContextPermissions.tsx');
  assert.match(strip, /export function ComposerContextPermissions\(\n  _props: [^)]*\[0\],\n\): null \{\n  return null;\n\}/);
  const effort = await applied('apps/web/src/components/chat/ComposerModelEffort.tsx');
  const footer = effort.slice(effort.indexOf('export function ComposerPickerFooter('));
  assert.doesNotMatch(footer.slice(0, footer.indexOf('\n}\n')), /<PermissionsMenu/);
  assert.match(footer, /px-3 py-2 empty:hidden/);
  // ChatView still places it (no anchor there); the component draws nothing.
  const view = await applied('apps/web/src/components/ChatView.tsx');
  assert.match(view, /<ComposerContextPermissions/);
});
