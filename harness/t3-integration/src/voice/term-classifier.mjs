// 받아쓴 말을 고쳐 보낸 그 자리에서, 고친 쌍 하나가 이름·용어인지 작은 모델에게 묻는다. 용어면
// vocabulary.mjs 가 최근 용어로 바로 힌트에 싣는다 — 사용자 꿈이 하루 한 번 본 목록에 합치기 전에도
// 다음 받아쓰기부터 맞게 나오게(사용자, 2026-11-24). 모델은 제목 사슬(titles.models)에서 구독으로
// 가는 것만 쓴다: OpenGateway 는 API 요금이라 건너뛴다(memory/service.mjs 와 같은 제약).
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTitleModels } from '../../../pi-runtime/features/session-title/session-title.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FALLBACK_MODEL = 'anthropic/claude-haiku-5-5';
const TERM_MAX = 60;

export const TERM_SYSTEM_PROMPT = [
  'A person dictated a message. Speech recognition wrote FROM; before sending, the person changed it to TO.',
  'Decide whether TO is a name or term the recognizer could not know: a person, company, product, project,',
  'code word, or a technical or business word of their work. Such a term should be spelled as TO in later',
  'dictation. An ordinary word, a particle or ending, or a change of what the person meant is not a term.',
  'Answer with JSON only: {"term": "<TO in its plain form, without particles or endings>"} or {"term": null}.',
].join(' ');

/** The model's answer as a term to keep, or null. */
export function parseTermAnswer(text) {
  const json = /\{[\s\S]*\}/.exec(String(text ?? ''))?.[0];
  if (!json) return null;
  let term;
  try { term = JSON.parse(json)?.term; } catch { return null; }
  if (typeof term !== 'string') return null;
  term = term.trim();
  return term && term.length <= TERM_MAX && !/[<>\r\n]/.test(term) ? term : null;
}

/** The subscription rungs of the title ladder, else Haiku. */
export function termModels(models = loadTitleModels()) {
  const rungs = models.filter((rung) => rung.provider !== 'opengateway')
    .map((rung) => ({ model: `${rung.provider}/${rung.id}`, reasoning: rung.reasoning ?? 'off' }));
  return rungs.length > 0 ? rungs : [{ model: FALLBACK_MODEL, reasoning: 'off' }];
}

/**
 * `run` answers one print-mode prompt ({model, reasoning, systemPrompt, prompt} → text); default: the
 * stock engine (stats/stories.mjs runPrint) with this profile's credentials.
 */
export function createTermClassifier({ env = process.env, run, models = () => termModels() } = {}) {
  const home = env.HOME ?? homedir();
  const agentDir = env.RUBATO_PI_CODING_AGENT_DIR?.trim() ? path.resolve(env.RUBATO_PI_CODING_AGENT_DIR) : path.join(home, '.rubato-pi', 'agent');
  const childEnv = { ...env, PI_CODING_AGENT_DIR: agentDir, RUBATO_PI_CODING_AGENT_DIR: agentDir, PATH: [
    path.join(home, '.bun', 'bin'), path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin',
  ].join(path.delimiter) };
  const ask = run ?? (async (request) => {
    const { runPrint, stockEngineLaunch } = await import('../stats/stories.mjs');
    return runPrint({ launch: await stockEngineLaunch(repoRoot, childEnv), env: childEnv, timeoutMs: 60_000, ...request });
  });
  return async function classify({ from, to }) {
    const prompt = `FROM: ${from}\nTO: ${to}`;
    for (const rung of models()) {
      try { return parseTermAnswer(await ask({ ...rung, systemPrompt: TERM_SYSTEM_PROMPT, prompt })); }
      catch { /* the next rung */ }
    }
    return null;
  };
}
