// Makes the Segno bot from the person's own Telegram account, over MTProto, by talking to
// @BotFather: the alternative is asking them to do it by hand in Telegram. The product then talks
// to that bot through the Bot API with the token this prints.
//
// Every message this sends goes to @BotFather alone, and it sends nothing else. In the product
// the accompaniment service runs this from Settings › Companion (`intent.action = 'create-bot'`);
// it is the same script either way.
//
//   node create-bot.mjs --name Segno --username segno_rubato_bot --username segno_companion_bot
//   node create-bot.mjs --name Segno --dry-run
//
// It reads @BotFather live (never the store) because the answer to a step is what decides the
// next one, and it waits for each answer by message id, so an old message is never mistaken for it.
import { execFile } from 'node:child_process';

export const BOTFATHER = '@BotFather';
const TOKEN = /\b(\d{8,10}:[A-Za-z0-9_-]{35})\b/;
const NAME_QUESTION = /how are we going to call it|Alright, a new bot/i;
const USERNAME_QUESTION = /choose a username/i;
const USERNAME_REJECTED = /already taken|invalid|can't be used|cannot be used|too long|must end in/i;
const TOO_MANY_ATTEMPTS = /too many attempts|try again later|slow down/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tg(args) {
  return new Promise((resolve, reject) => {
    execFile(process.env.RUBATO_TG_BIN ?? 'tg', args, { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout)));
  });
}

async function readBotFather(run) {
  const out = await run(['history', BOTFATHER, '--live', '--limit', '10', '--format', 'jsonl']);
  return String(out).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/** The newest @BotFather message after `afterId`, or a timeout. */
async function waitForAnswer(run, afterId, { sleep, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await readBotFather(run);
    const answer = rows.filter((row) => row.senderUsername === 'BotFather' && row.msgId > afterId).at(-1);
    if (answer) return answer;
    if (Date.now() >= deadline) throw new Error(`@BotFather did not answer within ${Math.round(timeoutMs / 1000)}s`);
    await sleep(1500);
  }
}

async function say(run, text) {
  // --raw keeps the chat-hygiene checks from rewriting a username or a slash command.
  await run(['send', BOTFATHER, text, '--raw']);
}

/**
 * @param {{ name: string, usernames: string[], run?: (args: string[]) => Promise<string>, sleep?: Function,
 *   timeoutMs?: number, dryRun?: boolean }} options
 *   `run` executes the `tg` CLI (a seam for tests); `dryRun` reports the messages it would send.
 */
export async function createBot({ name, usernames, run = tg, sleep = defaultSleep, timeoutMs = 90_000, dryRun = false } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('name is required');
  if (!Array.isArray(usernames) || !usernames.length) throw new TypeError('at least one username is required');
  for (const username of usernames)
    if (!/^[A-Za-z][A-Za-z0-9_]{3,30}bot$/.test(username)) throw new TypeError(`${username} is not a bot username (letters, digits, _, ending in bot)`);
  const steps = [['/newbot'], [name.trim()]];
  if (dryRun) return { dryRun: true, steps: [...steps, [usernames[0]]] };

  const before = await readBotFather(run);
  let watermark = Math.max(0, ...before.map((row) => row.msgId));

  await say(run, '/newbot');
  let answer = await waitForAnswer(run, watermark, { sleep, timeoutMs });
  watermark = answer.msgId;
  if (!NAME_QUESTION.test(answer.text ?? '')) throw new Error(`@BotFather did not ask for a name: ${answer.text ?? '(no text)'}`);

  await say(run, name.trim());
  answer = await waitForAnswer(run, watermark, { sleep, timeoutMs });
  watermark = answer.msgId;
  if (!USERNAME_QUESTION.test(answer.text ?? '')) throw new Error(`@BotFather did not ask for a username: ${answer.text ?? '(no text)'}`);

  const refused = [];
  for (const username of usernames) {
    await say(run, username);
    answer = await waitForAnswer(run, watermark, { sleep, timeoutMs });
    watermark = answer.msgId;
    const text = answer.text ?? '';
    const token = text.match(TOKEN)?.[1];
    if (token) return { token, username, name: name.trim() };
    if (TOO_MANY_ATTEMPTS.test(text)) throw new Error(`@BotFather asked to slow down: ${text.split('\n')[0]}`);
    if (USERNAME_REJECTED.test(text)) { refused.push({ username, answer: text.split('\n')[0] }); continue; }
    throw new Error(`@BotFather answered with something else: ${text.split('\n')[0]}`);
  }
  throw new Error(`no username was free (${refused.map((item) => item.username).join(', ')})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = (flag) => process.argv.flatMap((value, index) => (value === flag ? [process.argv[index + 1]] : [])).filter(Boolean);
  const arg = (flag, fallback) => all(flag).at(-1) ?? fallback;
  const dryRun = process.argv.includes('--dry-run');
  try {
    const made = await createBot({ name: arg('--name', 'Segno'), usernames: all('--username'), dryRun });
    process.stdout.write(JSON.stringify(made) + '\n');
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  }
}

export default createBot;

