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

function toolsOf(link) {
  const [feature] = createCompanionMessengerFactories({ sessionLink: link });
  const registered = new Map();
  feature.factory({ registerTool: (tool) => { registered.set(tool.name, tool); } });
  return registered;
}
const toolOf = (link, name = TELEGRAM_SEND_TOOL) => toolsOf(link).get(name);

test('the companion tool queues a message for the person and holds one for anyone else', async () => {
  const link = fakeLink();
  const tool = toolOf(link);
  assert.equal(tool.name, TELEGRAM_SEND_TOOL);
  assert.equal(tool.exposure, 'direct');

  const toUser = await tool.execute('call', { text: '보고드릴 게 있어요.' });
  assert.equal(link.queued[0].target, 'user');
  assert.equal(toUser.content[0].text, 'sent (id: 900)', "Roo's answer: the id it went out as");

  const toOther = await tool.execute('call', { text: '재현 경로를 알려주세요.', to: '-100123', name: '버그 리포트' });
  assert.deepEqual(link.queued[1].target, { chatId: '-100123', name: '버그 리포트' });
  assert.match(toOther.content[0].text, /Held for the person's approval/);
});

test('without an engine messenger the tool is not registered at all', () => {
  assert.deepEqual(createCompanionMessengerFactories({}), []);
  assert.deepEqual(createCompanionMessengerFactories(), []);
});

test("Roo's three Telegram hands: send with files and voice, react, edit — each a request to the messenger", async () => {
  const link = fakeLink();
  const tools = toolsOf(link);
  assert.deepEqual([...tools.keys()], [...TELEGRAM_TOOL_NAMES]);
  for (const tool of tools.values()) assert.equal(tool.exposure, 'direct');

  await tools.get(TELEGRAM_SEND_TOOL).execute('c1', { text: '사진이야', files: ['/tmp/a.jpg'], voice: true, voice_text: '사진 보냈어' });
  assert.deepEqual(link.queued[0], { id: 'q1', text: '사진이야', files: ['/tmp/a.jpg'], voice: true, voiceText: '사진 보냈어',
    sanitize: undefined, to: undefined, name: undefined, target: 'user', state: 'sent', messageIds: [900] });

  const reacted = await tools.get(TELEGRAM_REACT_TOOL).execute('c2', { emoji: '👍' });
  assert.equal(link.queued[1].op, 'react');
  assert.equal(link.queued[1].messageId, undefined, 'no id: the messenger picks the person\'s latest message');
  assert.equal(reacted.content[0].text, 'reacted');

  const edited = await tools.get(TELEGRAM_EDIT_TOOL).execute('c3', { message_id: 901, text: '고쳤어' });
  assert.deepEqual([link.queued[2].op, link.queued[2].messageId, link.queued[2].text], ['edit', 901, '고쳤어']);
  assert.equal(edited.content[0].text, 'edited (id: 901)');

  const held = await tools.get(TELEGRAM_REACT_TOOL).execute('c4', { emoji: '🙏', message_id: 5, to: '-100' });
  assert.match(held.content[0].text, /Held for the person's approval/);
});

test("the send tool says the answers already reach Telegram, so Segno does not say them twice", () => {
  const tool = toolOf(fakeLink());
  assert.match(tool.description, /already reach the person's Telegram on their own/);
  assert.equal(tool.parameters.required, undefined, 'a voice-only or file-only message needs no text');
});
