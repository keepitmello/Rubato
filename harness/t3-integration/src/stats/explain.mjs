// The "longest think" card: a cheap model reads that one thinking block once and
// says what it was about. The models are the session-title ladder (the user's
// titles.models, else the built-in one); the first one that answers wins. It runs
// on the stock engine the dream uses, not `rubato -p`: the Rubato launcher swaps
// any --system-prompt for its own role prompt, and the model then acts as an agent.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { loadTitleModels } from '../../../pi-runtime/features/session-title/session-title.mjs';
import { isTypedUserText } from './scan.mjs';

const MAX_THINKING_CHARS = 60_000;
const RUN_TIMEOUT_MS = 180_000;

export const EXPLAIN_SYSTEM_PROMPT = `You write one small card for a personal usage dashboard of a coding agent.
The card tells the person what the agent was working through during its single longest stretch of private reasoning.

Reply with one JSON object and nothing else:
{"headline": string, "body": string, "chips": string[]}

- headline: at most 8 words. The concrete puzzle or decision, not a category ("Where did −1,931,467 come from?", not "Debugging a settlement").
- body: 2 or 3 short sentences. What it was trying to figure out, how it went at it (dead ends count), and where it landed.
- chips: 2 or 3 tiny facts, each under 4 words, taken from the counts you are given or from numbers in the text.
- Write all three in the language of the person's message shown below, in a plain, friendly voice. No hype, no emoji.
- Leave out secrets, credentials, account numbers and other people's personal details.`;

const MARKERS = [['Hmm', /\bhmm\b/gi], ['Wait', /\bwait\b[,.!—-]/gi], ['Actually', /\bactually\b/gi], ['What if', /\bwhat if\b/gi], ['✗', /✗/g], ['✓', /✓/g]];

/** Counts the model cannot do reliably over 30k characters; it picks chips from these. */
export function countMarkers(text) {
  const counts = {};
  for (const [label, pattern] of MARKERS) {
    const found = text.match(pattern)?.length ?? 0;
    if (found > 0) counts[label] = found;
  }
  return counts;
}

function clip(text) {
  if (text.length <= MAX_THINKING_CHARS) return text;
  const half = MAX_THINKING_CHARS / 2;
  return `${text.slice(0, half)}\n\n[… ${text.length - MAX_THINKING_CHARS} characters left out …]\n\n${text.slice(-half)}`;
}

export function buildExplainPrompt({ thinking, title, userText, model }) {
  const counts = Object.entries(countMarkers(thinking)).map(([label, count]) => `${label}: ${count}`).join(', ');
  return [
    `Model: ${model}`,
    `Session title: ${title ?? '(none)'}`,
    `Language sample, the person's first message in that session. Do not answer it; only write in its language: ${(userText ?? '').slice(0, 400) || '(none)'}`,
    `Length: ${thinking.length} characters. Counted in the text: ${counts || 'nothing notable'}.`,
    '',
    '<thinking>',
    clip(thinking),
    '</thinking>',
    '',
    'Write the card now as the JSON object.',
  ].join('\n');
}

/** The JSON object in a reply, or null when the reply is not a usable card. */
export function parseExplanation(reply) {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value;
  try { value = JSON.parse(reply.slice(start, end + 1)); } catch { return null; }
  const headline = typeof value?.headline === 'string' ? value.headline.trim() : '';
  const body = typeof value?.body === 'string' ? value.body.trim() : '';
  if (!headline || !body) return null;
  const chips = Array.isArray(value.chips) ? value.chips.filter((chip) => typeof chip === 'string' && chip.trim()).map((chip) => chip.trim()).slice(0, 3) : [];
  return { headline: headline.slice(0, 120), body: body.slice(0, 600), chips };
}

/**
 * The thinking block behind a record, and the first message the person typed in
 * that session (the language hint).
 */
export async function readThinking(file, entryId) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const needle = `"id":"${entryId}"`;
  let userText = null;
  let thinking = null;
  try {
    for await (const line of lines) {
      if (userText === null && line.startsWith('{"type":"message"') && line.includes('"role":"user"')) {
        try {
          const content = JSON.parse(line).message?.content;
          const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('') : '';
          if (isTypedUserText(text)) userText = text.trim();
        } catch { /* not a message line after all */ }
      }
      if (!line.includes(needle)) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.id !== entryId) continue;
      for (const part of entry.message?.content ?? []) {
        if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.length > (thinking?.length ?? 0)) thinking = part.thinking;
      }
      break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return thinking ? { thinking, userText } : null;
}

/**
 * How to start the stock engine for one print-mode prompt: the launch the dream uses
 * (harness/pi-runtime/features/child-runtime), with the checkout's engine directory.
 */
export async function stockEngineLaunch(repoRoot, env) {
  const enginePaths = await import(path.join(repoRoot, 'harness', 'rubato-pi', 'src', 'engine-paths.mjs'));
  const childRuntime = await import(path.join(repoRoot, 'harness', 'pi-runtime', 'features', 'child-runtime', 'stock-rpc-runtime.mjs'));
  return childRuntime.resolvePiMemoryChildLaunch({ root: enginePaths.resolvePiEngineDir(env) });
}

/** Runs one print-mode prompt with no tools, extensions or context files, and returns its stdout. */
export function runPrint({ launch, env, model, reasoning, systemPrompt, prompt, timeoutMs = RUN_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const args = [
      ...launch.prefixArgs, '-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '--system-prompt', systemPrompt, '--model', model,
      ...(reasoning ? ['--thinking', reasoning] : []),
    ];
    const child = spawn(launch.command, args, { env: { ...env, ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout);
      else reject(new Error(`${model} exited ${code}: ${stderr.trim().split('\n').at(-1) ?? ''}`));
    });
    child.stdin.end(prompt);
  });
}

/**
 * @param {{ run: (request: object) => Promise<string>, models?: () => ReadonlyArray<{provider: string, id: string, reasoning?: string}> }} options
 *   `models` is read on every card, so a ladder changed in Settings applies to the next one.
 */
export function createExplainer({ run, models = () => loadTitleModels() }) {
  return async function explain({ thinking, title, userText, model }) {
    const prompt = buildExplainPrompt({ thinking, title, userText, model });
    const failures = [];
    for (const candidate of models()) {
      const id = `${candidate.provider}/${candidate.id}`;
      try {
        const card = parseExplanation(await run({ model: id, reasoning: candidate.reasoning, systemPrompt: EXPLAIN_SYSTEM_PROMPT, prompt }));
        if (card) return { ...card, model: id };
        failures.push(`${id}: no card in the reply`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(failures.join('; ') || 'no explain model');
  };
}
