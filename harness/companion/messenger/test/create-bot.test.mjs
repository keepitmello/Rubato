import assert from 'node:assert/strict';
import test from 'node:test';
import { createBot } from '../scripts/create-bot.mjs';

const TOKEN = '8123456789:AAHfakeTokenForTestsOnly_1234567890';

/** A @BotFather that answers like the real one, and records where every message went. */
function fakeBotFather({ refused = [] } = {}) {
  const rows = [];
  const sent = [];
  let msgId = 1000;
  const push = (row) => { msgId += 1; rows.push({ msgId, ...row }); return rows.at(-1); };
  push({ senderUsername: 'BotFather', out: false, text: 'an older message' });
  let stage = 'idle';
  const run = async (args) => {
    if (args[0] === 'history') return rows.map((row) => JSON.stringify(row)).join('\n');
    if (args[0] === 'send') {
      const [, chat, text] = args;
      assert.equal(chat, '@BotFather', 'nothing but @BotFather is ever messaged');
      sent.push(text);
      push({ senderUsername: 'me', out: true, text });
      if (text === '/newbot') {
        stage = 'name';
        push({ senderUsername: 'BotFather', out: false, text: 'Alright, a new bot. How are we going to call it? Please choose a name for your bot.' });
      } else if (stage === 'name') {
        stage = 'username';
        push({ senderUsername: 'BotFather', out: false, text: "Good. Now let's choose a username for your bot. It must end in `bot`." });
      } else if (stage === 'username') {
        if (refused.includes(text)) push({ senderUsername: 'BotFather', out: false, text: 'Sorry, this username is already taken. Please try something different.' });
        else push({ senderUsername: 'BotFather', out: false,
          text: `Done! Congratulations on your new bot. You will find it at t.me/${text}.\n\nUse this token to access the HTTP API:\n${TOKEN}\nKeep your token secure.` });
      }
      return '';
    }
    throw new Error(`unexpected tg call: ${args.join(' ')}`);
  };
  return { run, sent };
}

test('the bot is made by talking to @BotFather: name, then the first free username', async () => {
  const botfather = fakeBotFather({ refused: ['segno_rubato_bot'] });
  const made = await createBot({ name: 'Segno', usernames: ['segno_rubato_bot', 'segno_companion_bot'],
    run: botfather.run, sleep: async () => {} });
  assert.equal(made.token, TOKEN);
  assert.equal(made.username, 'segno_companion_bot');
  assert.deepEqual(botfather.sent, ['/newbot', 'Segno', 'segno_rubato_bot', 'segno_companion_bot']);
});

test('only a bot username is accepted before anything is sent', async () => {
  await assert.rejects(createBot({ name: 'Segno', usernames: ['Segno'] , run: async () => '', sleep: async () => {} }),
    /not a bot username/);
});

test('a dry run says which messages would go and sends none', async () => {
  const dry = await createBot({ name: 'Segno', usernames: ['segno_rubato_bot'], dryRun: true });
  assert.deepEqual(dry.steps, [['/newbot'], ['Segno'], ['segno_rubato_bot']]);
});

