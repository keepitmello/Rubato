// In-repo ToolGroupComponent at the fully-patched final state
// (baseline + #1 skill/git group + #18 turn-work + #22 status + #24 chrome).
// Vendor `tool-group.js` is a created file — a load transform cannot invent it.
// Importers (interactive-mode) are rewritten to this href.
import { pathToFileURL } from "node:url";
import { senpiDir, senpiNested } from "../engine-paths.mjs";
import { registerInternalAction } from "./internal-actions.mjs";

const { Container, hyperlink } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-tui/dist/index.js")).href
);
const { theme } = await import(
  pathToFileURL(`${senpiDir}/dist/modes/interactive/theme/theme.js`).href
);

export function toolGroupComponentHref() {
  return import.meta.url;
}

/**
 * 뭉치지 않는 도구. 결과가 곧 내용이라 접으면 남는 게 없다.
 */
export const UNGROUPED_TOOLS = new Set(["task", "dag", "team_create", "todo"]);

/**
 * 모델이 스킬을 쓰는 방법은 /skill:name 이 아니라 SKILL.md 를 read 하는 것이다.
 * 도구 이름은 read 그대로라서 뭉침이 그걸 일반 조회와 같이 접어 버린다.
 */
export function isSkillRead(toolName, args) {
  if (toolName !== "read" || args == null || typeof args !== "object") return false;
  const raw = args.file_path ?? args.path;
  if (typeof raw !== "string" || raw.length === 0) return false;
  const file = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  return file.toLowerCase() === "skill.md";
}

/**
 * bash 의 실제 명령이 git 이면 조회 뭉침에 넣지 않는다.
 * env 대입과 sudo/command 접두만 걷고, 첫 토큰이 git 인지 본다.
 */
export function isGitWork(toolName, args) {
  if (toolName !== "bash" || args == null || typeof args !== "object") return false;
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) return false;
  const token = firstCommandToken(command).replace(/\.exe$/i, "");
  return token === "git" || /(?:^|[/\\])git$/.test(token);
}

function firstCommandToken(command) {
  let rest = command.trim();
  while (true) {
    const env = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)/.exec(rest);
    if (!env) break;
    rest = rest.slice(env[0].length);
  }
  const prefix = /^(?:sudo|command)\s+/.exec(rest);
  if (prefix) rest = rest.slice(prefix[0].length);
  return /^[A-Za-z0-9._+/-\\]+/.exec(rest)?.[0] ?? "";
}

/** 실패한 도구 이름에 쓰는 색. 회색 목록에서 눈에는 걸리되 튀지 않는 벽돌빛. */
const FAILED_TOOL_COLOR = "\x1b[38;2;196;116;110m";
/** diff 증감. 실패색과 같은 채도로 맞춰 한 줄 안에서 따로 놀지 않게 한다. */
const DIFF_ADDED_COLOR = "\x1b[38;2;122;162;122m";
const DIFF_REMOVED_COLOR = "\x1b[38;2;196;116;110m";
const RESET = "\x1b[0m";

/**
 * edit 결과의 unified diff 에서 증감을 센다.
 * `---`/`+++` 헤더는 변경이 아니므로 걸러낸다.
 */
function countDiff(patch) {
  if (typeof patch !== "string" || patch.length === 0) return undefined;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return added === 0 && removed === 0 ? undefined : { added, removed };
}

/** 접힌 줄에 나열하는 도구 이름 최대 개수. 넘으면 …로 줄인다. */
const MAX_NAMES = 6;

function dim(text) {
  return theme.fg("dim", text);
}

/**
 * 연속된 도구 호출을 한 줄로 접는다.
 *
 * 접힘:  • 1 tool  ls·read·grep·edit·bash
 * 펼침:  각 도구가 자기 자신을 그린다.
 *
 * 실패한 도구는 줄을 늘리지 않고 이름만 색으로 표시한다 — 어디서
 * 깨졌는지는 보이되 성공한 턴과 높이가 같다.
 */
export class ToolGroupComponent extends Container {
  constructor(ui) {
    super();
    this.ui = ui;
    this.tools = [];
    this.expanded = false;
    this.turnWorkCollapsed = false;
    this.toggleAction = registerInternalAction(() => {
      this.setExpanded(!this.expanded);
      this.ui.requestRender();
    });
  }

  /** 이 도구를 뭉침에 넣을 수 있나. */
  static canGroup(toolName, args) {
    if (UNGROUPED_TOOLS.has(toolName)) return false;
    const nextArgs = args ?? undefined;
    return !isSkillRead(toolName, nextArgs) && !isGitWork(toolName, nextArgs);
  }

  addTool(component) {
    this.tools.push(component);
    this.addChild(component);
    component.toolGroup = this;
    component.setExpanded(this.expanded);
    this.invalidateGroup();
    this.ui.requestRender();
  }

  /**
   * args 가 늦게 와서 배치 뒤에야 스킬인 줄 알았을 때.
   * detach 만 하고 dispose 는 하지 않는다 — 그 컴포넌트는 외부가 계속 그린다.
   */
  removeTool(component) {
    const index = this.tools.indexOf(component);
    if (index === -1) return false;
    this.tools.splice(index, 1);
    this.detachChild(component);
    if (component.toolGroup === this) component.toolGroup = undefined;
    this.invalidateGroup();
    this.ui.requestRender();
    return true;
  }

  /**
   * 도구가 끝날 때마다 불린다. 줄 자체는 그대로고 숫자와 색만 바뀜다.
   */
  refresh() {
    this.invalidateGroup();
    this.ui.requestRender();
  }

  get size() {
    return this.tools.length;
  }

  /**
   * 배치 뒤에야 뭉치면 안 되는 도구인 줄 알았을 때.
   * 앞 도구는 이 그룹에 남기고, 뒤 도구는 새 그룹으로 넘긴다.
   * children 은 chatContainer.children 이다.
   */
  extractAt(component, children, createGroup) {
    const at = this.tools.indexOf(component);
    if (at === -1) return undefined;
    const after = this.tools.slice(at + 1);
    this.removeTool(component);
    for (const tool of after) this.removeTool(tool);
    const groupAt = children.indexOf(this);
    if (this.size === 0) {
      if (groupAt >= 0) children.splice(groupAt, 1, component);
      else children.push(component);
      this.dispose();
    } else if (groupAt >= 0) {
      children.splice(groupAt + 1, 0, component);
    } else {
      children.push(component);
    }
    if (after.length === 0) return undefined;
    const next = createGroup();
    const insertAt = children.indexOf(component);
    if (insertAt >= 0) children.splice(insertAt + 1, 0, next);
    else children.push(next);
    for (const tool of after) next.addTool(tool);
    return next;
  }

  setExpanded(expanded) {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    for (const tool of this.tools) tool.setExpanded(expanded);
    this.invalidateGroup();
  }

  setTurnWorkCollapsed(collapsed) {
    if (this.turnWorkCollapsed === collapsed) return;
    this.turnWorkCollapsed = collapsed;
    this.invalidateGroup();
  }

  workItems() {
    return this.tools.map((tool) => ({
      name: tool.identity?.toolName ?? "?",
      failed: tool.result?.isError === true,
    }));
  }

  invalidateGroup() {
    this.cachedLines = undefined;
    this.invalidate();
  }

  dispose() {
    this.toggleAction.dispose();
    super.dispose();
  }

  /**
   * 접힌 줄에 적을 도구 이름들. 실패한 것만 색을 입히고,
   * edit 은 바꾼 양이 곳 판단 근거라 증감을 붙인다.
   */
  formatNames() {
    const seen = [];
    for (const tool of this.tools) {
      const name = tool.identity?.toolName ?? "?";
      const failed = tool.result?.isError === true;
      const diff = name === "edit" ? countDiff(tool.result?.details?.patch) : undefined;
      const last = seen[seen.length - 1];
      // 같은 도구가 연달아 나오면 횟수로 묶는다. 실패나 diff 는 따로 남긴다.
      if (last && last.name === name && last.failed === failed && !diff && !last.diff) {
        last.count += 1;
        continue;
      }
      seen.push({ name, failed, diff, count: 1 });
    }
    const shown = seen.slice(0, MAX_NAMES);
    const rest = seen.length - shown.length;
    const parts = shown.map(({ name, failed, diff, count }) => {
      const counted = count > 1 ? `${name} (${count})` : name;
      const label = failed ? `${FAILED_TOOL_COLOR}${counted}${RESET}` : dim(counted);
      if (!diff) return label;
      const plus = `${DIFF_ADDED_COLOR}+${diff.added}${RESET}`;
      const minus = `${DIFF_REMOVED_COLOR}-${diff.removed}${RESET}`;
      return `${label} ${plus} ${minus}`;
    });
    let text = parts.join(dim("·"));
    if (rest > 0) text += dim(`·…+${rest}`);
    return text;
  }

  render(width) {
    void width;
    if (this.turnWorkCollapsed) return [];
    if (this.expanded) return super.render(width);
    if (this.tools.length === 0) return [];

    const count = this.tools.length;
    const label = `${count} ${count === 1 ? "tool" : "tools"}`;
    // 숨긴 줄 수는 적지 않는다 — 펼칠지 말지를 그 숫자로 정하지는 않았다.
    // edit 의 증감만 예외로, 바뀜 양은 클릭 전에도 알아야 한다.
    const line = `${dim(`  • ${label}`)}  ${this.formatNames()}`;
    return [hyperlink(line, this.toggleAction.url)];
  }
}
