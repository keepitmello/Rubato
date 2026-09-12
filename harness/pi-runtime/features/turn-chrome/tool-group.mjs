// Collapse a run of consecutive tool calls into one line.
//
//   collapsed:  • 5 tools  read (3)·bash·edit +12 -3
//   expanded:   every tool renders itself
//
// Stock lists each tool call raw, so a turn that reads six files pushes the
// answer off screen. Ported from harness/rubato-pi/src/transforms/
// tool-group-component.mjs; the OSC-8 action bus it used for clicks is replaced
// by the component's own handleMouse, which is what stock pi-tui offers.
import { Container, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../../modes/interactive/theme/theme.js";

/** Tools whose result IS the content: grouping them leaves nothing to read. */
export const UNGROUPED_TOOLS = new Set(["task", "team_create", "todo"]);

/**
 * A model uses a skill by reading its SKILL.md, so the tool name is plain
 * "read" and grouping would fold that intent into ordinary lookups.
 */
export function isSkillRead(toolName, args) {
  if (toolName !== "read" || args == null || typeof args !== "object") return false;
  const raw = args.file_path ?? args.path;
  if (typeof raw !== "string" || raw.length === 0) return false;
  const file = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  return file.toLowerCase() === "skill.md";
}

/** bash whose real command is git is work, not a lookup. */
export function isGitWork(toolName, args) {
  if (toolName !== "bash" || args == null || typeof args !== "object") return false;
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) return false;
  const token = firstCommandToken(command).replace(/\.exe$/i, "");
  return token === "git" || /(?:^|[/\\])git$/.test(token);
}

function firstCommandToken(command) {
  let rest = command.trim();
  for (;;) {
    const env = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)/.exec(rest);
    if (!env) break;
    rest = rest.slice(env[0].length);
  }
  const prefix = /^(?:sudo|command)\s+/.exec(rest);
  if (prefix) rest = rest.slice(prefix[0].length);
  return /^[A-Za-z0-9._+/\\-]+/.exec(rest)?.[0] ?? "";
}

/** Failed tool name: visible in a dim list without shouting. */
const FAILED_TOOL_COLOR = "\u001b[38;2;196;116;110m";
const DIFF_ADDED_COLOR = "\u001b[38;2;122;162;122m";
const DIFF_REMOVED_COLOR = "\u001b[38;2;196;116;110m";
const RESET = "\u001b[0m";
/** Tool names listed on the collapsed line before it elides. */
const MAX_NAMES = 6;

function dim(text) {
  return theme.fg("dim", text);
}

/** Count +/- in an edit result's unified diff; headers are not changes. */
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

export class ToolGroupComponent extends Container {
  constructor(ui) {
    super();
    this.ui = ui;
    this.tools = [];
    this.expanded = false;
    this.turnWorkCollapsed = false;
  }

  /** Can this tool join a group at all. */
  static canGroup(toolName, args) {
    if (UNGROUPED_TOOLS.has(toolName)) return false;
    const nextArgs = args ?? undefined;
    return !isSkillRead(toolName, nextArgs) && !isGitWork(toolName, nextArgs);
  }

  addTool(component) {
    this.tools.push(component);
    this.addChild(component);
    component.setExpanded(this.expanded);
    this.ui.requestRender();
  }

  /** A tool finished: the line keeps its place, only counts and colors move. */
  refresh() {
    this.ui.requestRender();
  }

  get size() {
    return this.tools.length;
  }

  setExpanded(expanded) {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    for (const tool of this.tools) tool.setExpanded(expanded);
  }

  setTurnWorkCollapsed(collapsed) {
    this.turnWorkCollapsed = collapsed;
  }

  workItems() {
    return this.tools.map((tool) => ({
      name: tool.toolName ?? "?",
      failed: tool.result?.isError === true,
    }));
  }

  /** Names for the collapsed line; only failures take color. */
  formatNames() {
    const seen = [];
    for (const tool of this.tools) {
      const name = tool.toolName ?? "?";
      const failed = tool.result?.isError === true;
      const diff = name === "edit" ? countDiff(tool.result?.details?.patch) : undefined;
      const last = seen[seen.length - 1];
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
      return `${label} ${DIFF_ADDED_COLOR}+${diff.added}${RESET} ${DIFF_REMOVED_COLOR}-${diff.removed}${RESET}`;
    });
    let text = parts.join(dim("·"));
    if (rest > 0) text += dim(`·…+${rest}`);
    return text;
  }

  render(width) {
    if (this.turnWorkCollapsed) return [];
    if (this.expanded) return super.render(width);
    if (this.tools.length === 0) return [];
    const count = this.tools.length;
    const label = `${count} ${count === 1 ? "tool" : "tools"}`;
    const line = `${dim(`  • ${label}`)}  ${this.formatNames()}`;
    // Container.handleMouse reads this layout; a collapsed group does not use it.
    this.mouseLayout = undefined;
    return ["", truncateToWidth(line, width, "")];
  }

  handleMouse(event) {
    if (this.turnWorkCollapsed) return undefined;
    if (this.expanded) return super.handleMouse(event);
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.setExpanded(true);
    this.ui.requestRender();
    return { handled: true };
  }
}
