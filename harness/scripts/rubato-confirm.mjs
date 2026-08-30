#!/usr/bin/env node
// 키보드로 고르는 예/아니오. 세션이 뜨기 직전 업데이트를 받을지 묻는다.
//
//   rubato-confirm.mjs "rubato 업데이트 3개를 받을까?" [--default-no] [--timeout 20]
//
// 종료 코드: 0 = 예, 1 = 아니오/취소/그릴 수 없음.
//
// 조작은 ← → 와 h l 로 옮기고 Enter 로 고른다. y n 은 곧바로 답이고,
// Esc 와 Ctrl-C 는 아니오다. 어느 쪽이든 한 번의 입력으로 끝난다.
//
// 그릴 수 없는 곳(파이프, CI, TERM=dumb, NO_COLOR)에서는 묻지 않고 1로 빠진다.
// 세션 시작을 막지 않는 것이 묻는 것보다 중요하다.

import { stdin, stdout, argv, env, exit } from "node:process";

const args = argv.slice(2);
const question = args.find((a) => !a.startsWith("--")) ?? "계속할까?";
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// 기본값. --default-no 면 커서가 「나중에」에서 시작한다.
let yes = !flag("--default-no");

// 아무도 안 보고 있을 때를 위한 마감. 지나면 기본값으로 답한다.
const timeoutSec = Number(value("--timeout") ?? 0);

// 그릴 수 없으면 묻지 않는다. tty 를 양쪽 다 요구한다 — 입력만 있고 출력이
// 파이프면 질문이 로그로 새어 나가고, 출력만 있고 입력이 없으면 영원히 기다린다.
if (
  !stdin.isTTY ||
  !stdout.isTTY ||
  env.TERM === "dumb" ||
  env.NO_COLOR ||
  env.RUBATO_NO_TUI
) {
  exit(1);
}

const ESC = "\u001b";
const RST = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const REV = `${ESC}[7m`;

// 스플래시와 같은 색 규칙. truecolor 를 알리면 그라데이션, 아니면 256색.
const truecolor = env.COLORTERM === "truecolor" || env.COLORTERM === "24bit";
const ACCENT = truecolor ? `${ESC}[38;2;244;162;97m` : `${ESC}[38;5;215m`;
const GREEN = truecolor ? `${ESC}[38;2;138;177;125m` : `${ESC}[38;5;108m`;

const write = (s) => stdout.write(s);

// 그린 줄 수. 지울 때 이만큼 되감는다.
const LINES = 4; // 빈 줄 + 질문 + 빈 줄 + 버튼

function render(first) {
  if (!first) write(`${ESC}[${LINES - 1}A`); // 질문 줄 위로 되감기
  else write("\r\n");

  write(`${ESC}[2K  ${ACCENT}✦${RST} ${BOLD}${question}${RST}\r\n`);
  write(`${ESC}[2K\r\n`);

  const on = (label) => `${REV}${GREEN} ${label} ${RST}`;
  const off = (label) => `${DIM} ${label} ${RST}`;
  const btnYes = yes ? on("받기") : off("받기");
  const btnNo = yes ? off("나중에") : on("나중에");

  write(
    `${ESC}[2K  ${btnYes}  ${btnNo}   ${DIM}← →  Enter${RST}\r\n`,
  );
}

// 그린 것을 지운다. 무엇을 골랐든 화면에는 흔적을 남기지 않는다 —
// 남길 한 줄은 부른 쪽이 정한다.
function erase() {
  for (let i = 0; i < LINES; i++) write(`${ESC}[2K${ESC}[1A`);
  write(`${ESC}[2K\r`);
}

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  erase();
  write(`${ESC}[?25h`); // 커서 복구
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
  exit(code);
}

write(`${ESC}[?25l`); // 커서 감춤
render(true);

stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding("utf8");

const timer = timeoutSec > 0
  ? setTimeout(() => finish(yes ? 0 : 1), timeoutSec * 1000)
  : null;

stdin.on("data", (key) => {
  switch (key) {
    case "\u0003": // Ctrl-C
    case "\u001b": // Esc
      return finish(1);
    case "\r":
    case "\n":
      return finish(yes ? 0 : 1);
    case "y":
    case "Y":
      yes = true;
      return finish(0);
    case "n":
    case "N":
      yes = false;
      return finish(1);
    case `${ESC}[D`: // ←
    case `${ESC}[C`: // →
    case "\t":
    case "h":
    case "l":
      yes = !yes;
      return render(false);
    default:
      // 모르는 키는 무시한다. 실수로 세션이 안 뜨는 편이 낫다.
      return;
  }
});

// 터미널이 사라지면(창을 닫으면) 붙잡고 있지 않는다.
stdin.on("end", () => finish(1));
