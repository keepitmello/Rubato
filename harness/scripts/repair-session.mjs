#!/usr/bin/env node
// `rubato repair-session <id>`: reconnect entries whose parent never reached the session file.
//
// A write that failed after its entry was already in memory (a full disk) left the next
// entry pointing at a parent the file does not have. Opening that session then stops on
// "세션 원본에서 상위 항목 … 을 찾지 못했어요" every turn: the reader refuses to drop history
// silently. This repair does what was done by hand on 2026-09-28: keep a backup, and hang
// each orphan from the entry right before it in the file, which is where it was written.
// Opening never repairs on its own; rewriting a file on a full disk can cut it again.
import { chmodSync, copyFileSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Returns { text, repairs, malformed } for the JSONL text of one session file. */
export function repairParentLinks(text) {
  const lines = text.split('\n');
  const parsed = lines.map((line) => {
    if (!line.trim()) return undefined;
    try { return JSON.parse(line); } catch { return null; }
  });
  const ids = new Set(parsed.filter((entry) => entry && entry.type !== 'session' && typeof entry.id === 'string').map((entry) => entry.id));
  const repairs = [];
  let malformed = 0;
  let previous;
  parsed.forEach((entry, index) => {
    if (entry === null) { malformed++; return; }
    if (!entry || entry.type === 'session') return;
    if (typeof entry.parentId === 'string' && !ids.has(entry.parentId) && previous !== undefined) {
      repairs.push({ id: entry.id, missingParentId: entry.parentId, newParentId: previous });
      lines[index] = JSON.stringify({ ...entry, parentId: previous });
    }
    previous = entry.id;
  });
  return { text: lines.join('\n'), repairs, malformed };
}

export function findSessionFile(sessionsDir, idOrPath) {
  if (idOrPath.endsWith('.jsonl')) return path.resolve(idOrPath);
  const matches = readdirSync(sessionsDir, { recursive: true })
    .filter((name) => name.endsWith('.jsonl') && path.basename(name).includes(idOrPath))
    .map((name) => path.join(sessionsDir, name));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `세션 ${idOrPath} 의 파일을 ${sessionsDir} 에서 찾지 못했어요.`
      : `세션 ${idOrPath} 에 맞는 파일이 ${matches.length}개예요. 더 긴 id 나 파일 경로를 주세요.`);
  }
  return matches[0];
}

export function repairSessionFile(file, { now = new Date() } = {}) {
  const { text, repairs, malformed } = repairParentLinks(readFileSync(file, 'utf8'));
  if (repairs.length === 0) return { file, repairs, malformed };
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const backup = `${file}.bak-${stamp}-repair`;
  copyFileSync(file, backup);
  const temp = `${file}.repair-tmp`;
  writeFileSync(temp, text);
  chmodSync(temp, statSync(file).mode & 0o777);
  renameSync(temp, file);
  return { file, backup, repairs, malformed };
}

async function main(argv) {
  const target = argv[0];
  if (!target || argv.length !== 1 || target.startsWith('-')) {
    console.error('usage: rubato repair-session <session-id | file.jsonl>');
    return 2;
  }
  const { resolveLaunchAgentDir } = await import('../rubato-pi/src/launch.mjs');
  const file = findSessionFile(path.join(resolveLaunchAgentDir(), 'sessions'), target);
  const result = repairSessionFile(file);
  if (result.malformed) console.log(`읽을 수 없는 줄 ${result.malformed}개는 그대로 두었어요.`);
  if (result.repairs.length === 0) {
    console.log(`끊긴 곳이 없어요: ${file}`);
    return 0;
  }
  for (const repair of result.repairs) {
    console.log(`${repair.id}: 없는 ${repair.missingParentId} 대신 바로 앞 항목 ${repair.newParentId} 에 이었어요.`);
  }
  console.log(`원본: ${result.backup}`);
  console.log('엔진이 이 대화를 이미 열어 두었다면 옛 기록을 들고 있어요. `rubato restart` 뒤에 다시 열면 고친 파일로 열려요.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
