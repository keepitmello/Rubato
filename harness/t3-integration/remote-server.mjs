// Rubato 서버를 SSH 원격 환경으로 띄우는 진입점.
//
// 데스크톱이 다른 기계(리눅스·WSL 등)를 환경으로 붙이면, 원본 T3 는 GitHub 에서
// 자기 릴리스를 받아 띄운다. 그 서버에는 Rubato 제공자가 없다. 그래서 overlay 가
// 데스크톱의 원격 실행기를 `node ~/.rubato/t3-remote-server.mjs` 로 바꾸고,
// install-gui.sh 가 그 파일을 이 모듈로 이어준다. 원격 기계에도 Rubato 를
// `install.sh --apply --gui` 로 깔아 두어야 한다.
//
// 여기서 하는 일은 둘이다.
//  1. 원격 실행기는 PATH 의 첫 node 를 쓴다(22 일 수 있다). 로컬 앱과 같은 Node
//     24+ 에서 돌도록, 설치 때 고른 node 로 프로세스를 갈아끼운다(execve — pid 가
//     그대로라 원격 실행기의 pid 추적이 깨지지 않는다).
//  2. 원격 실행기는 `--base-dir ~/.t3` 를 넘긴다. Rubato 설정(제공자·브리지 경로)은
//     T3 홈(~/.rubato/t3-home)에 있으므로 그리로 돌린다. --base-dir 가 환경변수보다
//     세서 T3CODE_HOME 으로는 못 바꾼다.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function rewriteBaseDir(args, t3Home) {
  const out = [...args];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === '--base-dir' && i + 1 < out.length) out[i + 1] = t3Home;
    else if (out[i].startsWith('--base-dir=')) out[i] = `--base-dir=${t3Home}`;
  }
  return out;
}

export async function startRemoteServer({ t3Source, t3Home, node }) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24 && node && existsSync(node) && typeof process.execve === 'function'
    && !process.env.RUBATO_REMOTE_REEXEC) {
    process.execve(node, [node, ...process.execArgv, process.argv[1], ...process.argv.slice(2)],
      { ...process.env, RUBATO_REMOTE_REEXEC: '1' });
  }
  const entry = path.join(t3Source, 'apps/server/dist/bin.mjs');
  if (!existsSync(entry)) {
    process.stderr.write(`Rubato 서버 번들이 없다: ${entry}\n원격에서 install.sh --apply --gui 를 먼저 돌려라.\n`);
    process.exit(1);
  }
  process.argv = [process.argv[0], process.argv[1], ...rewriteBaseDir(process.argv.slice(2), t3Home)];
  await import(pathToFileURL(entry).href);
}
