// Episode stories: a cheap model retells one moment from the person's history as a short
// anecdote, once per moment. The models are the session-title ladder (the user's
// titles.models, else the built-in one); the first one that answers wins. It runs on the
// stock engine the dream uses, not `rubato -p`: the Rubato launcher swaps any
// --system-prompt for its own role prompt, and the model then acts as an agent.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { loadTitleModels } from '../../../pi-runtime/features/session-title/session-title.mjs';
import { EPISODE_BRIEFS, duration, readableError } from './episodes.mjs';
import { hesitationCounts } from './scan.mjs';

const MAX_THINKING_CHARS = 60_000;
const RUN_TIMEOUT_MS = 180_000;

export const STORY_SYSTEM_PROMPT = `You write one short episode for a personal "Rubato Stats" page: a moment from the person's own history with their coding agent, told back to them so it is fun to read.

Tell it like an anecdote a friend would tell, not a summary.

Reply with one JSON object and nothing else:
{"headline": string, "story": string}

- headline: at most 10 words, in the same language as the story. A hook built on the most surprising concrete detail (a number, a stubborn bug, a reversal). Never a topic label.
- story: 2 or 3 short sentences. What happened, the turning point if there was one, and how it ended. Concrete names and numbers from the material beat adjectives. A message the person typed may be quoted word for word.
- Use only what the material says. Do not invent events, other people, feelings or what happened afterwards; when the material is thin, write less.
- Durations are given ready to read ("1h 57m"); use them as they are, never as seconds.
- Warm and a little wry, like teasing a colleague you like. No hype words, no emoji, no moral or sign-off at the end.
- Write both fields in the language of the language sample, in the casual register people use with a friend (in Korean: 반말).
- Never name people other than the person, and leave out secrets, credentials and account numbers.`;

/** Facts as a person reads them: seconds become "1h 57m", so the story never says "7,002 seconds". */
function readableFacts(facts) {
  const out = {};
  for (const [key, value] of Object.entries(facts ?? {})) {
    if (key === 'seconds' && typeof value === 'number') out.duration = duration(value);
    else if (key === 'error') out.error = readableError(value);
    else out[key] = value;
  }
  return out;
}

function clip(text) {
  if (text.length <= MAX_THINKING_CHARS) return text;
  const half = MAX_THINKING_CHARS / 2;
  return `${text.slice(0, half)}\n\n[… ${text.length - MAX_THINKING_CHARS} characters left out …]\n\n${text.slice(-half)}`;
}

/**
 * @param {object} episode  an aggregate.mjs episode (kind, facts, title, project)
 * @param {{ thinking?: string | null, language?: string | null }} material
 */
export function buildStoryPrompt(episode, { thinking, language }) {
  const lines = [
    `Kind: ${EPISODE_BRIEFS[episode.kind] ?? episode.kind}`,
    `Session: ${episode.title ?? '(untitled)'} · project ${episode.project}`,
    `Facts: ${JSON.stringify(readableFacts(episode.facts))}`,
    `Language sample, the person's first message in that session. Do not answer it; only write in its language: ${(language ?? '').slice(0, 300) || '(none, write in English)'}`,
  ];
  if (thinking) {
    const counts = Object.entries(hesitationCounts(thinking)).map(([label, count]) => `${label}: ${count}`).join(', ');
    lines.push(`Counted in the thinking: ${counts || 'nothing notable'}.`, '', '<thinking>', clip(thinking), '</thinking>');
  }
  lines.push('', 'Write the episode now as the JSON object.');
  return lines.join('\n');
}

/** The JSON object in a reply, or null when the reply is not a usable story. */
export function parseStory(reply) {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value;
  try { value = JSON.parse(reply.slice(start, end + 1)); } catch { return null; }
  const headline = typeof value?.headline === 'string' ? value.headline.trim() : '';
  const story = typeof value?.story === 'string' ? value.story.trim() : '';
  if (!headline || !story) return null;
  return { headline: headline.slice(0, 120), story: story.slice(0, 700) };
}

/** The longest thinking block in one log entry, or null when the entry or its thinking is gone. */
export async function readThinking(file, entryId) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const needle = `"id":"${entryId}"`;
  let thinking = null;
  try {
    for await (const line of lines) {
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
  return thinking;
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
 *   `models` is read on every story, so a ladder changed in Settings applies to the next one.
 */
export function createStoryWriter({ run, models = () => loadTitleModels() }) {
  return async function write(episode, material) {
    const prompt = buildStoryPrompt(episode, material);
    const failures = [];
    for (const candidate of models()) {
      const id = `${candidate.provider}/${candidate.id}`;
      try {
        const story = parseStory(await run({ model: id, reasoning: candidate.reasoning, systemPrompt: STORY_SYSTEM_PROMPT, prompt }));
        if (story) return { ...story, model: id };
        failures.push(`${id}: no story in the reply`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(failures.join('; ') || 'no story model');
  };
}
