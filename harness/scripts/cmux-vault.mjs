#!/usr/bin/env node
// cmux Vault 에 rubato 를 등록한다 — cmux 를 껐다 켜도 세션이 돌아오게.
//
// cmux 는 터미널 안에서 도는 코딩 에이전트를 감지해 세션 JSONL 을 기억하고,
// 앱이 다시 뜨면 resume 명령으로 이어붙인다. Pi 는 기본 지원이지만 rubato 는
// 두 군데서 어긋난다:
//   - 프로세스가 `pi` 가 아니라 `node .../rubato-pi.mjs` 로 뜬다
//   - 세션이 ~/.pi 가 아니라 ~/.rubato-pi/agent/sessions 에 쌓인다
// 둘 다 vault.agents 에 명시해서 맞춘다.
//
// 기본은 상태만 본다. --print 는 붙여넣을 블록을, --apply 는 실제로 쓴다.
// 미등록이면 넣고, 경로가 옵기면(하네스를 옮기면 절대경로가 깨진다) 고친다.
// cmux.json 은 사용자가 손으로 고치는 JSONC 라 쓰면 주석을 잃는다.
// --apply 가 반드시 백업을 남기는 이유다.
//
// 부르는 곳은 `rubato update` 단 하나다. 따로 서브커맨드를 두지 않는다.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const CONFIG = join(HOME, ".config", "cmux", "cmux.json");
const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(HERE, "rubato-pi.sh");
const AGENT_ID = "rubato";

// JSONC → JSON. 문자열 안의 `//` 를 주석으로 오해하지 않게 상태를 따라간다.
export function stripJsonc(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  // 후행 쉼표는 JSON 이 거부한다. 주석을 걷어낸 뒤에야 안전하게 지울 수 있다.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function buildAgent(launcher = LAUNCHER) {
  return {
    id: AGENT_ID,
    name: "Rubato",
    detect: {
      processName: "node",
      argvContains: "rubato-pi/bin/rubato-pi.mjs",
    },
    sessionIdSource: "piSessionFile",
    sessionDirectory: "~/.rubato-pi/agent/sessions",
    resumeCommand: `${launcher} --session {{sessionPath}}`,
    forkCommand: `${launcher} --fork {{sessionPath}}`,
    cwd: "preserve",
  };
}

// 이미 등록됐나. 경로가 다른 클론을 가리키면 stale 이다.
export function inspect(config, launcher = LAUNCHER) {
  const agents = config?.vault?.agents;
  const found = Array.isArray(agents)
    ? agents.find((a) => a && a.id === AGENT_ID)
    : undefined;
  if (!found) return { state: "missing" };
  const want = buildAgent(launcher).resumeCommand;
  if (found.resumeCommand !== want) return { state: "stale", found };
  return { state: "ok", found };
}

function blockText(launcher = LAUNCHER) {
  const agent = buildAgent(launcher);
  return [
    '  "vault": {',
    '    "agents": [',
    JSON.stringify(agent, null, 2)
      .split("\n")
      .map((l) => "      " + l)
      .join("\n"),
    "    ]",
    "  },",
    "",
    '  "terminal": {',
    '    "autoResumeAgentSessions": true',
    "  },",
  ].join("\n");
}

function apply(raw, config, launcher) {
  const agent = buildAgent(launcher);
  const next = structuredClone(config);
  next.vault ||= {};
  next.vault.agents = Array.isArray(next.vault.agents) ? next.vault.agents : [];
  const idx = next.vault.agents.findIndex((a) => a && a.id === AGENT_ID);
  if (idx >= 0) next.vault.agents[idx] = agent;
  else next.vault.agents.push(agent);
  next.terminal ||= {};
  next.terminal.autoResumeAgentSessions = true;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${CONFIG}.${stamp}.bak`;
  copyFileSync(CONFIG, backup);
  // 주석은 잃는다. 백업이 그래서 필수다.
  writeFileSync(CONFIG, JSON.stringify(next, null, 2) + "\n");
  return backup;
}

function main() {
  const mode = process.argv[2] ?? "--check";

  if (!existsSync(CONFIG)) {
    console.log("cmux 설정이 없다 (~/.config/cmux/cmux.json). cmux 를 안 쓰면 넘어가도 된다.");
    process.exit(mode === "--check" ? 0 : 1);
  }

  const raw = readFileSync(CONFIG, "utf8");
  let config;
  try {
    config = JSON.parse(stripJsonc(raw));
  } catch (e) {
    console.error(`cmux.json 을 읽지 못했다: ${e.message}`);
    console.error("`cmux config doctor` 로 먼저 문법을 확인해라.");
    process.exit(1);
  }

  const { state } = inspect(config, LAUNCHER);

  if (mode === "--check") {
    if (state === "ok") console.log("cmux Vault: rubato 등록됨 — 재시작해도 세션이 돌아온다");
    else if (state === "stale") console.log("cmux Vault: rubato 가 다른 경로를 가리킨다 (--apply 로 고친다)");
    else console.log("cmux Vault: rubato 미등록 (--print 로 블록을 보고 --apply 로 넣는다)");
    process.exit(0);
  }

  if (mode === "--print") {
    console.log(blockText(LAUNCHER));
    process.exit(0);
  }

  if (mode === "--apply") {
    if (state === "ok") {
      console.log("이미 맞다. 바꾸지 않았다.");
      process.exit(0);
    }
    const backup = apply(raw, config, LAUNCHER);
    const verb = state === "stale" ? "경로를 이 클론으로 고쳤다" : "를 등록했다";
    console.log(`cmux.json 에 rubato ${verb}. 백업: ${backup}`);
    process.exit(0);
  }

  console.error("사용법: cmux-vault.mjs [--check|--print|--apply]");
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
