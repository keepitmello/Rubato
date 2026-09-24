#!/usr/bin/env node
// 이 기계의 데스크톱이 SSH 환경으로 붙여 둔 기계를 한 줄에 하나씩 낸다.
//   <alias>\t<username 또는 빈칸>\t<port 또는 빈칸>
//
// 목록을 따로 두지 않고 데스크톱이 쓰는 것을 읽는다. 두 벌이면 앱에서 환경을
// 지우거나 꺼도 업데이트는 옛 기계를 계속 찾아간다. 데스크톱의 연결 카탈로그
// (connection-catalog.json)는 safeStorage 로 암호화돼 셸에서 못 읽으므로, overlay
// 가 카탈로그를 저장할 때마다 옆에 쓰는 ssh-environments.json 을 읽는다
// (apply.mjs 의 DesktopConnectionCatalogStore.ts 편집). 앱에서 꺼 둔 환경
// (disabledEnvironmentIds)은 뺀다. alias 를 내는 이유는 ssh 설정(ProxyJump 등)을
// 그대로 타야 해서다 — 데스크톱도 alias 로 붙는다.
//
// 파일이 없거나 읽을 수 없으면 아무것도 내지 않는다. 업데이트를 막을 일이 아니다.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function sshRemoteHosts(doc) {
  const disabled = new Set(Array.isArray(doc?.disabledEnvironmentIds) ? doc.disabledEnvironmentIds : []);
  const seen = new Set();
  const hosts = [];
  for (const profile of Array.isArray(doc?.profiles) ? doc.profiles : []) {
    if (profile?._tag !== 'SshConnectionProfile' || disabled.has(profile.environmentId)) continue;
    const target = profile.target ?? {};
    if (typeof target.alias !== 'string' || !/^[A-Za-z0-9._@-]+$/.test(target.alias)) continue;
    const user = typeof target.username === 'string' && /^[A-Za-z0-9._-]+$/.test(target.username) ? target.username : '';
    const port = Number.isInteger(target.port) ? String(target.port) : '';
    const line = `${target.alias}\t${user}\t${port}`;
    if (seen.has(line)) continue;
    seen.add(line);
    hosts.push(line);
  }
  return hosts;
}

if (import.meta.main) {
  const t3Home = process.env.RUBATO_T3_HOME || path.join(homedir(), '.rubato/t3-home');
  const catalog = process.argv[2] || path.join(t3Home, 'userdata/ssh-environments.json');
  let doc;
  try { doc = JSON.parse(readFileSync(catalog, 'utf8')); } catch { process.exit(0); }
  for (const line of sshRemoteHosts(doc)) process.stdout.write(`${line}\n`);
}
