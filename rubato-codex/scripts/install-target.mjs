import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

export async function chooseInstallTarget(options, { interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), ask } = {}) {
  let target = options.target;
  if (!target && interactive) {
    const rl = ask ? null : createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await (ask || (q => rl.question(q)))(
        '설치 방식: [1] 별도 Rubato.app (기본값, Codex 보존)  [2] 기존 Codex에 Rubato 적용\n선택 [1]: ');
      if (!['', '1', '2'].includes(answer.trim())) throw new Error('1 또는 2를 선택하세요.');
      target = answer.trim() === '2' ? 'codex' : 'app';
    } finally { rl?.close(); }
  }
  target ||= 'app';
  if (!['app', 'codex'].includes(target)) throw new Error('--target must be app or codex');
  if (target === 'app' && options.codexHome) throw new Error('--codex-home requires --target codex; Rubato.app manages its isolated home.');
  if (target === 'app' && options.codexPath) throw new Error('--codex requires --target codex; use --upstream-app for Rubato.app.');
  return { ...options, target };
}

export function appPaths(options = {}, home = homedir()) {
  return {
    appPath: resolve(options.appPath || '/Applications/Rubato.app'),
    codexHome: join(home, '.rubato', 'codex'),
    // Rubato's existing remote tooling already uses the parent directory.
    electronHome: join(home, 'Library', 'Application Support', 'Rubato', 'Codex'),
    updaterLink: join(home, '.local', 'bin', 'rubato-update'),
  };
}
