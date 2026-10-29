import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompanionMessengerFactories, TELEGRAM_EDIT_TOOL, TELEGRAM_REACT_TOOL, TELEGRAM_SEND_TOOL, TELEGRAM_TOOL_NAMES }
  from '../../../pi-runtime/features/companion-messenger/index.mjs';

/** The engine's sessionLink as the tool sees it. */
function fakeLink() {
  const queued = [];
  return {
    queued,
    // Like sessionLink.telegramSend, an empty `to` means the person's own chat.
    telegramSend: async (request) => {
      const { to, name } = request;
      const target = to === undefined || to === null || to === '' || to === 'user' ? 'user' : String(to);
      const row = { id: `q${queued.length + 1}`, ...request, target: target === 'user' ? 'user' : { chatId: target, ...(name ? { name } : {}) },
        state: target === 'user' ? 'sent' : 'held', ...(target === 'user' ? { messageIds: [900 + queued.length] } : {}) };
      queued.push(row);
      return row;
    },
  };
}

/** The tools as the runtime registers them; `telegram` is the runtime's option for the Telegram hands. */
function toolsOf(link, { telegram = true } = {}) {
  const [feature] = createCompanionMessengerFactories({ sessionLink: link, telegram });
  const registered = new Map();
  feature.factory({ registerTool: (tool) => { registered.set(tool.name, tool); } });
  return registered;
}
test('connecting Telegram never registers a second send tool alongside reply', () => {
  assert.equal(toolsOf(fakeLink()).has(TELEGRAM_SEND_TOOL), false);
});

test('without an engine messenger the tool is not registered at all', () => {
  assert.deepEqual(createCompanionMessengerFactories({}), []);
  assert.deepEqual(createCompanionMessengerFactories(), []);
  assert.deepEqual(createCompanionMessengerFactories({ sessionLink: fakeLink() }), [], 'Telegram is off unless the runtime asks for it');
});

test('with Telegram off (the product default) Segno has the settings tool and no Telegram tool, and its words name no Telegram', async () => {
  const { COMPANION_SETTINGS_TOOL } = await import('../../../pi-runtime/features/companion-messenger/index.mjs');
  const link = { ...fakeLink(), companionSettings: async () => ({}) };
  const [feature] = createCompanionMessengerFactories({ sessionLink: link });
  const registered = new Map();
  feature.factory({ registerTool: (tool) => { registered.set(tool.name, tool); } });
  assert.deepEqual([...registered.keys()], [COMPANION_SETTINGS_TOOL]);
  const settings = registered.get(COMPANION_SETTINGS_TOOL);
  const words = JSON.stringify([settings.description, settings.searchKeywords, settings.parameters]);
  assert.doesNotMatch(words, /telegram|botToken|fishKey|pairing|Fish/i);
});

test('Telegram reaction and edit remain transport-specific actions, including approval for another chat', async () => {
  const link = fakeLink();
  const tools = toolsOf(link);
  assert.deepEqual([...tools.keys()], [...TELEGRAM_TOOL_NAMES]);
  for (const tool of tools.values()) assert.equal(tool.exposure, 'direct');

  const reacted = await tools.get(TELEGRAM_REACT_TOOL).execute('c2', { emoji: '👍' });
  assert.equal(link.queued[0].op, 'react');
  assert.equal(link.queued[0].messageId, undefined, 'no id: the messenger picks the person\'s latest message');
  assert.equal(reacted.content[0].text, 'reacted');

  const edited = await tools.get(TELEGRAM_EDIT_TOOL).execute('c3', { message_id: 901, text: '고쳤어' });
  assert.deepEqual([link.queued[1].op, link.queued[1].messageId, link.queued[1].text], ['edit', 901, '고쳤어']);
  assert.equal(edited.content[0].text, 'edited (id: 901)');

  const held = await tools.get(TELEGRAM_REACT_TOOL).execute('c4', { emoji: '🙏', message_id: 5, to: '-100' });
  assert.match(held.content[0].text, /Held for the person's approval/);
});

test('the settings tool asks the engine with this conversation\'s id, and is there only when the engine offers it', async () => {
  const { COMPANION_SETTINGS_TOOL } = await import('../../../pi-runtime/features/companion-messenger/index.mjs');
  const asked = [];
  const link = { ...fakeLink(), companionSettings: async (request) => { asked.push(request); return { applied: ['companion'] }; } };
  const tool = toolsOf(link).get(COMPANION_SETTINGS_TOOL);
  assert.equal(tool.exposure, 'direct');
  const answer = await tool.execute('c1', { action: 'change', change: { companion: { greetings: { enabled: false } } } }, undefined, undefined,
    { sessionManager: { getSessionId: () => 'S1' } });
  assert.deepEqual(asked, [{ sessionId: 'S1', action: 'change', piece: undefined, change: { companion: { greetings: { enabled: false } } } }]);
  assert.deepEqual(answer.details, { applied: ['companion'] });
  assert.match(tool.description, /companion-settings skill/);
  assert.equal(toolsOf(fakeLink()).has(COMPANION_SETTINGS_TOOL), false);
  assert.match(toolsOf(link).get(COMPANION_SETTINGS_TOOL).description, /botToken/, 'with Telegram on, its settings come back');
});
