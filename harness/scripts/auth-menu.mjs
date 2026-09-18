// 방향키 전용 메뉴. `rubato auth` 는 명령어를 치게 하지 않는다.
//
// 터미널 한 자리에서 다시 그리는 목록 하나가 전부다. 키 해석(`normalizeKey`)과
// 그리기(`renderMenu`)를 순수 함수로 두어 TTY 없이도 테스트가 붙는다.
import { emitKeypressEvents } from "node:readline";

const CLEAR_BELOW = "\x1b[0J";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";

export const BACK = Symbol("back");
export const QUIT = Symbol("quit");

/** raw 입력 한 덩어리를 우리가 아는 동작 이름으로 줄인다. 모르는 키는 undefined. */
export function normalizeKey(str, key = {}) {
  if (key.ctrl && (key.name === "c" || key.name === "d")) return "quit";
  if (key.name === "up" || key.name === "k") return "up";
  if (key.name === "down" || key.name === "j") return "down";
  if (key.name === "left" || key.name === "h") return "left";
  if (key.name === "right" || key.name === "l") return "right";
  if (key.name === "return" || key.name === "enter" || str === "\r" || str === "\n") return "enter";
  if (key.name === "escape") return "escape";
  if (key.name === "backspace") return "escape";
  if (key.name === "space") return "enter";
  if (key.name === "home") return "home";
  if (key.name === "end") return "end";
  if (key.name === "pageup") return "home";
  if (key.name === "pagedown") return "end";
  if (key.name === "tab") return "down";
  if (typeof str === "string" && /^[0-9]$/.test(str)) return str;
  if (typeof str === "string" && /^[qQ]$/.test(str)) return "quit";
  return undefined;
}

/**
 * 키를 하나씩 꺼내 주는 읽개. raw 모드는 이 객체가 소유한다 — 로그인처럼 줄
 * 입력이 필요한 자리는 `suspend()` 로 잠시 돌려주고 `resume()` 으로 되찾는다.
 */
export function createKeyReader({ stdin = process.stdin } = {}) {
  emitKeypressEvents(stdin);
  const queue = [];
  const waiters = [];
  const onKey = (str, key) => {
    const action = normalizeKey(str, key);
    if (!action) return;
    const waiter = waiters.shift();
    if (waiter) waiter(action);
    else queue.push(action);
  };
  let raw = false;
  const setRaw = (on) => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return;
    if (raw === on) return;
    stdin.setRawMode(on);
    raw = on;
  };
  stdin.on("keypress", onKey);
  setRaw(true);
  stdin.resume?.();
  return {
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    suspend() {
      setRaw(false);
      stdin.off?.("keypress", onKey);
    },
    resume() {
      stdin.on?.("keypress", onKey);
      setRaw(true);
      stdin.resume?.();
    },
    close() {
      setRaw(false);
      stdin.off?.("keypress", onKey);
      stdin.pause?.();
    },
  };
}

function selectable(item) {
  return item !== null && item !== undefined && item.separator !== true && item.disabled !== true;
}

export function firstSelectable(items, from = 0) {
  for (let step = 0; step < items.length; step++) {
    const index = (from + step + items.length) % items.length;
    if (selectable(items[index])) return index;
  }
  return -1;
}

export function moveCursor(items, cursor, delta) {
  if (items.length === 0) return cursor;
  let index = cursor;
  for (let step = 0; step < items.length; step++) {
    index = (index + delta + items.length) % items.length;
    if (selectable(items[index])) return index;
  }
  return cursor;
}

/** 화면에 쓸 줄들. 커서 줄만 `❯` 와 반전으로 표시한다. */
export function renderMenu({ title, items, cursor, hint, header = [] }) {
  const lines = [];
  if (title) lines.push(title);
  for (const line of header) lines.push(line);
  items.forEach((item, index) => {
    if (item.separator) {
      lines.push(item.label ?? "");
      return;
    }
    const active = index === cursor;
    const mark = active ? "\x1b[36m❯\x1b[0m " : "  ";
    const label = active ? `\x1b[1m${item.label}\x1b[0m` : item.label;
    const detail = item.detail ? `  \x1b[2m${item.detail}\x1b[0m` : "";
    lines.push(`${mark}${label}${detail}`);
  });
  if (hint) lines.push(hint);
  return lines;
}

/**
 * 목록 하나를 띄우고 고른 값을 돌려준다. 되돌아가면 `BACK`, 종료면 `QUIT`.
 *
 * `painted` 만큼 커서를 올려 지우고 다시 쓰므로 스크롤백이 메뉴로 채워지지 않는다.
 */
export async function runMenu({
  stdout = process.stdout,
  keys,
  title,
  header,
  hint,
  items,
  index = 0,
  quitOnBack = false,
}) {
  let cursor = firstSelectable(items, index);
  let painted = 0;
  const draw = () => {
    const lines = renderMenu({ title, items, cursor, hint, header });
    const rewind = painted > 0 ? `\x1b[${painted}A\r${CLEAR_BELOW}` : "";
    stdout.write(`${rewind}${lines.join("\n")}\n`);
    painted = lines.length;
  };
  const erase = () => {
    if (painted > 0) stdout.write(`\x1b[${painted}A\r${CLEAR_BELOW}`);
    painted = 0;
  };
  stdout.write(HIDE_CURSOR);
  try {
    draw();
    while (true) {
      const action = await keys.next();
      if (action === "quit") {
        erase();
        return quitOnBack ? QUIT : BACK;
      }
      if (action === "escape" || action === "left") {
        erase();
        return quitOnBack ? QUIT : BACK;
      }
      if (action === "up") cursor = moveCursor(items, cursor, -1);
      else if (action === "down") cursor = moveCursor(items, cursor, 1);
      else if (action === "home") cursor = firstSelectable(items, 0);
      else if (action === "end") cursor = moveCursor(items, firstSelectable(items, 0), -1);
      else if (action === "enter" || action === "right") {
        const chosen = items[cursor];
        if (chosen && selectable(chosen)) {
          erase();
          return chosen.value;
        }
      } else if (/^[1-9]$/.test(action)) {
        const wanted = Number.parseInt(action, 10);
        let seen = 0;
        const found = items.findIndex((item) => selectable(item) && ++seen === wanted);
        if (found >= 0) {
          erase();
          return items[found].value;
        }
      }
      draw();
    }
  } finally {
    stdout.write(SHOW_CURSOR);
  }
}
