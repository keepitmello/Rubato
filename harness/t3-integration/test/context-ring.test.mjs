import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// The composer's context ring with the prompt cache (cache-edits.mjs) and one Mac
// microphone (voice-edits.mjs), read from an applied tree. The ring's own rendering is
// covered by RubatoCacheSection.test.tsx in the web app.
const applied = (relative) => readFile(path.join(process.env.T3_SOURCE, relative), 'utf8');
const skip = { skip: !process.env.T3_SOURCE };

test('the ring sits left of the send button and gets the thread\'s context and cache', skip, async () => {
  const composer = await applied('apps/web/src/components/chat/ChatComposer.tsx');
  const ring = composer.indexOf('<ContextWindowMeter\n');
  const send = composer.indexOf('<ComposerFooterPrimaryActions\n');
  assert.ok(ring > 0 && ring < send, 'ring before the primary actions');
  assert.match(composer, /usage=\{rubatoContextWindow\}/);
  assert.match(composer, /rubatoCache=\{rubatoCache\}/);
  assert.match(composer, /onCompact=\{rubatoCompactAvailable \? compactThreadContextStable : undefined\}/);
  const view = await applied('apps/web/src/components/ChatView.tsx');
  assert.match(view, /rubatoContextWindow=\{activeContextWindow\}/);
  assert.match(view, /rubatoCache=\{rubatoSessionState\.cache\}/);
  // Thread details no longer carries a second copy of the cache.
  const details = await applied('apps/web/src/components/chat/ThreadDetailsPanel.tsx');
  assert.doesNotMatch(details, /RubatoCacheSection/);
});

test('the Mac composer shows only Rubato\'s microphone', skip, async () => {
  const composer = await applied('apps/web/src/components/chat/ChatComposer.tsx');
  // T3's dictation button, capsule and shortcut stay off in the desktop app.
  assert.match(composer, /\{speechInput\.available && !isElectron \? \(/);
  assert.match(composer, /speech: speechInput,\n\s+disabled: dictationDisabled \|\| isElectron,/);
  assert.match(composer, /\{isElectron \? \(\n\s+<RubatoVoiceControl/);
});

test('the ring keeps v0.1.0\'s setting: off unless turned on, switched from Settings › Labs', skip, async () => {
  const contracts = await applied('packages/contracts/src/settings.ts');
  assert.match(contracts, /contextWindowMeterEnabled: Schema\.Boolean\.pipe\(Schema\.withDecodingDefault\(Effect\.succeed\(false\)\)\),/);
  assert.match(contracts, /contextWindowMeterEnabled: Schema\.optionalKey\(Schema\.Boolean\),/);
  const composer = await applied('apps/web/src/components/chat/ChatComposer.tsx');
  assert.match(composer, /\{dictationTakesFooter \|\| !settings\.contextWindowMeterEnabled \? null : rubatoContextWindow \? \(/);
  const labs = await applied('apps/web/src/components/settings/LabsSettingsPanel.tsx');
  assert.match(labs, /<RubatoContextRingRow \/>/);
  assert.match(labs, /checked=\{settings\.contextWindowMeterEnabled\}/);
  const search = await applied('apps/web/src/components/settings/settingsSearch.ts');
  assert.match(search, /id: "legacy-context-window-indicator",\n\s+title: msg\("Context window indicator \(legacy\)"\),\n\s+to: "\/settings\/labs",/);
});
