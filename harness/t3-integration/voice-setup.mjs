#!/usr/bin/env node
// 맥에 음성 입력 설정을 심는다. 사용자가 직접 부를 때만 홈 디렉터리를 건드리고,
// 설치·재시작·빌드는 하지 않는다 — 그건 별도 승인이다.
//
//   node voice-setup.mjs --model <id> [--key <openai-key>] [--project <projectId>]
//   node voice-setup.mjs --show
//   node voice-setup.mjs --rotate-token

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.RUBATO_VOICE_CONFIG
  ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), '.rubato', 'voice.json');

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const usage = `맥 음성 입력 설정

  --model <id>        전사에 쓸 OpenAI 모델 id (필수, 설정에 남는다)
  --key <key>         OpenAI API 키. 없으면 환경변수 → 로그인 셸 순으로 찾는다
  --project <id>      새 대화를 만들 때 쓸 T3 프로젝트 id (선택)
  --rotate-token      단축어가 쓰는 토큰을 새로 만든다
  --show              지금 설정만 보여준다 (토큰과 키는 가린다)

설정 파일: ${configPath}
`;

if (has('help') || has('h')) {
  process.stdout.write(usage);
  process.exit(0);
}

const existing = await readFile(configPath, 'utf8')
  .then((raw) => JSON.parse(raw))
  .catch(() => ({}));

const mask = (secret) => (typeof secret === 'string' && secret.length > 8
  ? `${secret.slice(0, 6)}…(${secret.length}자)`
  : secret);

/**
 * 셸이 이미 알고 있는 키를 쓴다. 키는 보통 `~/.zshrc` 가 소스하는 파일에 있고,
 * 이 스크립트를 비대화 셸에서 돌리면 그 값이 환경변수로 안 넘어온다. 그래서
 * 로그인 셸에 한 번 물어본다 — 소스 사슬이 어떻든 셸이 아는 값을 그대로 얻는다.
 */
function openAiKeyFromShell() {
  const shell = process.env.SHELL || '/bin/zsh';
  let output;
  try {
    output = execFileSync(shell, ['-ic', 'printf %s "$OPENAI_API_KEY"'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  // 셸 시작 스크립트가 찍는 잡음은 버리고, 공백 없는 마지막 줄만 키로 본다.
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const key = lines.filter((line) => !/\s/.test(line)).at(-1);
  return typeof key === 'string' && key.startsWith('sk-') ? key : null;
}

if (has('show')) {
  process.stdout.write(`${JSON.stringify({
    ...existing,
    token: mask(existing.token),
    openaiApiKey: mask(existing.openaiApiKey),
  }, null, 2)}\n`);
  process.exit(0);
}

const model = value('model') ?? existing.model;
const project = value('project') ?? existing.defaultProjectId;
const token = has('rotate-token') || typeof existing.token !== 'string'
  ? randomBytes(32).toString('base64url')
  : existing.token;

const givenKey = value('key');
const environmentKey = process.env.OPENAI_API_KEY;
const shellKey = givenKey || environmentKey ? null : openAiKeyFromShell();
const apiKey = givenKey ?? environmentKey ?? shellKey ?? existing.openaiApiKey;
const keySource = givenKey ? '--key'
  : environmentKey ? 'OPENAI_API_KEY 환경변수'
    : shellKey ? '로그인 셸(보통 ~/.zshrc 가 소스하는 파일)'
      : existing.openaiApiKey ? '이전 설정 파일'
        : null;

if (typeof model !== 'string' || model.trim() === '') {
  process.stderr.write('전사 모델 id가 필요하다: --model <id>\n');
  process.exit(1);
}
if (typeof apiKey !== 'string' || apiKey.trim() === '') {
  process.stderr.write('OpenAI 키를 찾지 못했다: --key <key> 로 주거나 셸에 OPENAI_API_KEY 를 두어라\n');
  process.exit(1);
}

const config = {
  module: path.join(root, 'src', 'voice', 'runtime.mjs'),
  token,
  model,
  openaiApiKey: apiKey,
  ...(project ? { defaultProjectId: project } : {}),
};

await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await chmod(configPath, 0o600);

process.stdout.write([
  `설정을 썼다: ${configPath} (0600)`,
  '',
  `전사 모델: ${model}`,
  `OpenAI 키: ${keySource} 에서 읽음 (${mask(apiKey)})`,
  `프로젝트: ${project ?? '아직 없음 — 대화를 연 채로 음성 입력을 한 번 쓰면 그 프로젝트를 기억한다'}`,
  '',
  '아이폰 단축어에 넣을 토큰:',
  token,
  '',
  '다음:',
  '  1. T3 데스크톱 앱을 다시 시작해야 이 설정을 읽는다.',
  '  2. 단축어 설정은 같은 폴더의 voice-input.md 를 따라.',
  '',
].join('\n'));
