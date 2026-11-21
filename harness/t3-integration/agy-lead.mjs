// 공식 agy 를 깐 사용자에게 Rubato 리드를 agy 에이전트로 건넨다. 두 가지를 한다.
//
//   에이전트 — ~/.gemini/config/agents/rubato-lead.md. 리드 시스템 프롬프트 정본
//              (harness/prompts 조각)에서 매번 만든다. 손으로 따로 들고 있는 사본은
//              정본과 갈라지기 때문이다. agy 에 없는 Rubato 도구(팀·서브에이전트·
//              스킬·기억·이미지)를 말하는 문단은 빼고, agy 안에서 일한다는 문단을 넣는다.
//   인스턴스 — T3 의 "루바토 리드". local-agy-edits.mjs 가 그 에이전트로 공식 agy 를 띄운다.
//
// 사람 것은 건드리지 않는다. 표식 줄이 없는 에이전트 파일은 사용자가 쓴 것이라 그대로
// 두고, 같은 id 의 인스턴스가 이미 있으면 그대로 둔다. 인스턴스는 한 번만 넣는다 —
// 사용자가 지운 것을 업데이트마다 되살리지 않는다.
import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEAD_AGENT = 'rubato-lead';
export const LEAD_INSTANCE_ID = 'agy-rubato-lead';
export const GENERATED_MARK =
  '<!-- Rubato 설치기가 harness/prompts 의 리드 프롬프트로 만든다. 고친 내용을 지키려면 이 줄을 지워라. -->';
const PROMPTS = fileURLToPath(new URL('../prompts/', import.meta.url));

const FRONTMATTER = [
  '---',
  `name: ${LEAD_AGENT}`,
  'description: 루바토 리드 — 방향을 같이 잡고, 맡긴 작업을 확인까지 마무리하는 메인 에이전트',
  'mainAgent: true',
  'subagent: false',
  'excludeDefaultComponents: true',
  'tools:',
  '  - read_file',
  '  - write_file',
  '  - edit_file',
  '  - run_command',
  'commandExecutionPolicy: sandbox',
  '---',
].join('\n');

// agy 안에서 일한다는 것. 리드 프롬프트 정본에서 유일하게 갈라지는 문장이다.
const AGY_ENVIRONMENT = [
  '# Here',
  "I run inside the official agy CLI. I use the file and terminal tools agy actually gives me, edit only within what the user handed me, and keep agy's permission and confirmation steps. Rubato's teams, subagents, skills, memory and image tools are not here, so I do not assume them.",
].join('\n\n');

// 정본 build.sh 의 리드 순서에서 브리프 교환(서브에이전트 계약)을 뺐다. 말투가 마지막인
// 이유도 build.sh 와 같다.
const PIECES = ['preamble.pi.md', 'base.pi.md', 'core-lead.pi.md', AGY_ENVIRONMENT, 'calm.pi.md', 'voice.md'];
export const RUBATO_ONLY = /Skill\(|`Agent`|team_create|AgentPause|tool_search|memory_search|image_create|Mermaid|verifier/;

export async function renderLeadAgent(promptsDir = PROMPTS) {
  const sections = [];
  for (const piece of PIECES) {
    const text = piece.endsWith('.md') ? await readFile(path.join(promptsDir, piece), 'utf8') : piece;
    sections.push(text.split(/\n{2,}/).map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph && !RUBATO_ONLY.test(paragraph)).join('\n\n'));
  }
  return `${FRONTMATTER}\n\n${GENERATED_MARK}\n\n${sections.join('\n\n')}\n`;
}

// PATH 먼저, 그다음 공식 설치기가 두는 ~/.local/bin. launchd 로 도는 업데이트는 PATH 가
// 짧아서 뒤쪽이 없으면 못 찾는다. 인스턴스에는 절대경로가 들어가야 한다.
export async function findAgy(env) {
  const directories = (env.PATH ?? '').split(path.delimiter).filter((entry) => path.isAbsolute(entry));
  if (env.HOME) directories.push(path.join(env.HOME, '.local', 'bin'));
  for (const directory of directories) {
    const candidate = path.join(directory, 'agy');
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* 다음 자리 */ }
  }
  return null;
}

export async function installLeadAgent(home, promptsDir = PROMPTS) {
  const file = path.join(home, '.gemini', 'config', 'agents', `${LEAD_AGENT}.md`);
  let current = null;
  try { current = await readFile(file, 'utf8'); } catch { /* 처음 */ }
  if (current !== null && !current.includes(GENERATED_MARK)) return 'kept';
  const next = await renderLeadAgent(promptsDir);
  if (current === next) return 'unchanged';
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next);
  return 'written';
}

export function leadInstance(agyPath) {
  return {
    driver: 'antigravity',
    displayName: '루바토 리드',
    environment: [{ name: 'RUBATO_LOCAL_AGY_AGENT', value: LEAD_AGENT, sensitive: false }],
    enabled: true,
    config: { authMethod: 'oauth-personal', binaryPath: agyPath },
  };
}

/** Adds the lead instance unless that id exists. Returns whether it added one. */
export function seedLeadInstance(instances, agyPath) {
  if (Object.hasOwn(instances, LEAD_INSTANCE_ID)) return false;
  instances[LEAD_INSTANCE_ID] = leadInstance(agyPath);
  return true;
}
