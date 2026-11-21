import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// The thread composer's controls in v0.1.0's places, the new-thread composer as T3 v0.1.11
// (composer-layout-edits.mjs), read from an applied tree.
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

test('a thread: model and access lead; speed, mic, call, attach, ring and send follow', skip, async () => {
  const composer = await applied('apps/web/src/components/chat/ChatComposer.tsx');
  const footer = composer.slice(composer.lastIndexOf('data-chat-composer-footer="true"'));
  const thread = footer.slice(footer.indexOf('{routeKind !== "draft" ? ('));
  order(thread, [
    'justify-start gap-0.5',
    '{composerControls}',
    'data-chat-composer-actions="right"',
    'data-rubato-speed-label',
    '{routeKind !== "draft" ? (\n                    <>',
    '<RubatoVoiceControl',
    '<RubatoCallComposerButton',
    '{composerAttachButton && !dictationTakesFooter ? composerAttachButton : null}',
    '<ContextWindowMeter',
    '<ComposerFooterPrimaryActions',
  ]);
});

test('a new thread keeps T3 v0.1.11: mic, call and attach lead; model, ring and send at the right', skip, async () => {
  const composer = await applied('apps/web/src/components/chat/ChatComposer.tsx');
  const footer = composer.slice(composer.lastIndexOf('data-chat-composer-footer="true"'));
  const draftLeading = footer.slice(footer.indexOf(') : (\n                  <>'));
  order(draftLeading, ['<RubatoVoiceControl', '<RubatoCallComposerButton', '<div className="me-2">{composerAttachButton}</div>',
    'data-chat-composer-actions="right"', 'justify-end gap-0.5', '<ContextWindowMeter', '<ComposerFooterPrimaryActions']);
});

test('the model button keeps its effort; the picker opens from the left in a thread', skip, async () => {
  const bar = await applied('apps/web/src/components/chat/ComposerControlsBar.tsx');
  assert.match(bar, /popupAlign=\{routeKind !== "draft" \|\| composerControlsCollapsed \? "start" : "end"\}/);
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
