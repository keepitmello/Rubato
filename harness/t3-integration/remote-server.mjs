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
//     24+ 에서 돌도록 설치 때 고른 node 를 쓴다.
//  2. 원격 실행기는 `--base-dir ~/.t3` 를 넘긴다. Rubato 설정(제공자·브리지 경로)은
//     T3 홈(~/.rubato/t3-home)에 있으므로 그리로 돌린다. --base-dir 가 환경변수보다
//     세서 T3CODE_HOME 으로는 못 바꾼다.
//
// 서버 번들(bin.mjs)은 import 하지 않고 프로세스의 진입점으로 띄운다. bin.mjs 는
// import.meta.main 일 때만 CLI 를 돌려서, import 하면 아무 출력 없이 0 으로 끝난다.
// execve 가 있으면 프로세스를 갈아끼우고(pid 유지), 없으면(22.23 에도 없었다)
// 자식으로 띄워 신호를 넘기고 자식의 종료 코드로 끝난다 — 원격 실행기는 이 pid 에
// TERM 을 보내 서버를 끈다.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function rewriteBaseDir(args, t3Home) {
  const out = [...args];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === '--base-dir' && i + 1 < out.length) out[i + 1] = t3Home;
    else if (out[i].startsWith('--base-dir=')) out[i] = `--base-dir=${t3Home}`;
  }
  return out;
}

export function startRemoteServer({ t3Source, t3Home, node }) {
  const entry = path.join(t3Source, 'apps/server/dist/bin.mjs');
  if (!existsSync(entry)) {
    process.stderr.write(`Rubato 서버 번들이 없다: ${entry}\n원격에서 install.sh --apply --gui 를 먼저 돌려라.\n`);
    process.exit(1);
  }
  const major = Number(process.versions.node.split('.')[0]);
  const runtime = major < 24 && node && existsSync(node) ? node : process.execPath;
  const args = [entry, ...rewriteBaseDir(process.argv.slice(2), t3Home)];
  if (typeof process.execve === 'function') process.execve(runtime, [runtime, ...args], process.env);
  const child = spawn(runtime, args, { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
