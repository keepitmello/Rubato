import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompanionMessengerFactories, TELEGRAM_SEND_TOOL } from '../../../pi-runtime/features/companion-messenger/index.mjs';

/** The engine's sessionLink as the tool sees it. */
function fakeLink() {
  const queued = [];
  return {
    queued,
    // Like sessionLink.telegramSend, an empty `to` means the person's own chat.
    telegramSend: async ({ text, to, name }) => {
      const target = to === undefined || to === null || to === '' || to === 'user' ? 'user' : String(to);
      const row = { id: `q${queued.length + 1}`, text, target: target === 'user' ? 'user' : { chatId: target, ...(name ? { name } : {}) }, state: 'queued' };
      queued.push(row);
      return row;
    },
  };
}

function toolOf(link) {
  const [feature] = createCompanionMessengerFactories({ sessionLink: link });
  let registered;
  feature.factory({ registerTool: (tool) => { registered = tool; } });
  return registered;
}

test('the companion tool queues a message for the person and holds one for anyone else', async () => {
  const link = fakeLink();
  const tool = toolOf(link);
  assert.equal(tool.name, TELEGRAM_SEND_TOOL);
  assert.equal(tool.exposure, 'direct');

  const toUser = await tool.execute('call', { text: '보고드릴 게 있어요.' });
  assert.equal(link.queued[0].target, 'user');
  assert.match(toUser.content[0].text, /Queued/);

  const toOther = await tool.execute('call', { text: '재현 경로를 알려주세요.', to: '-100123', name: '버그 리포트' });
  assert.deepEqual(link.queued[1].target, { chatId: '-100123', name: '버그 리포트' });
  assert.match(toOther.content[0].text, /Held for the person's approval/);
});

test('without an engine messenger the tool is not registered at all', () => {
  assert.deepEqual(createCompanionMessengerFactories({}), []);
  assert.deepEqual(createCompanionMessengerFactories(), []);
});
