// One line per turn: what the model did to get to the answer.
//
//   • Worked 3 steps · 2 updates · thought 14s · 5 tools: ✓ read (3) · ✗ bash
//
// While the turn streams the line grows live. When the turn ends the component
// collapses the turn's thinking blocks, tool groups and progress narration into
// itself, leaving the answer and this one line. Clicking it puts them back.
// Ported from harness/rubato-pi/src/transforms/turn-work-summary.mjs; clicks
// come from the component's own handleMouse instead of the OSC-8 action bus.
import { Container, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../../modes/interactive/theme/theme.js";
import { isToolUseEllipsisFiller, phaseForTextContent } from "./assistant-phase.mjs";

function compactDuration(ms) {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function thinkingStats(message, now = Date.now()) {
  let steps = 0;
  let thoughtMs = 0;
  let inRun = false;
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  const closeRun = () => {
    if (!inRun) return;
    steps += 1;
    if (Number.isFinite(minStart)) {
      thoughtMs += Math.max(0, (Number.isFinite(maxEnd) ? maxEnd : now) - minStart);
    }
    inRun = false;
    minStart = Number.POSITIVE_INFINITY;
    maxEnd = Number.NEGATIVE_INFINITY;
  };
  for (const content of message?.content ?? []) {
    if (content.type !== "thinking") {
      closeRun();
      continue;
    }
    inRun = true;
    if (Number.isFinite(content.startedAt)) minStart = Math.min(minStart, content.startedAt);
    if (Number.isFinite(content.endedAt)) maxEnd = Math.max(maxEnd, content.endedAt);
  }
  closeRun();
  return { steps, thoughtMs };
}

function compactTools(groups, width) {
  const seen = [];
  const indexByKey = new Map();
  for (const group of groups) {
    for (const item of group.workItems?.() ?? []) {
      const key = `${item.failed ? "1" : "0"}\u0000${item.name}`;
      const existing = indexByKey.get(key);
      if (existing !== undefined) {
        seen[existing].count += 1;
        continue;
      }
      indexByKey.set(key, seen.length);
      seen.push({ ...item, count: 1 });
    }
  }
  const labels = seen.map(({ name, failed, count }) => `${failed ? "✗" : "✓"} ${name}${count > 1 ? ` (${count})` : ""}`);
  const full = labels.join(" · ");
  if ([...full].length <= width) return full;
  const shown = [];
  for (let index = 0; index < labels.length; index++) {
    const suffix = ` · …+${labels.length - index - 1}`;
    const candidate = `${[...shown, labels[index]].join(" · ")}${suffix}`;
    if ([...candidate].length > width) break;
    shown.push(labels[index]);
  }
  const remaining = labels.length - shown.length;
  return remaining > 0 ? `${shown.join(" · ")}${shown.length > 0 ? " · " : ""}…+${remaining}` : full;
}

export class TurnWorkSummaryComponent extends Container {
  constructor(ui) {
    super();
    this.ui = ui;
    this.assistants = new Map();
    this.toolGroups = new Set();
    this.expanded = false;
    this.requestCompleted = false;
    this.terminalStatus = undefined;
  }

  /** Collapse the turn's own work only after the turn is over. */
  applyPresentation() {
    const collapsed = this.requestCompleted && !this.expanded;
    for (const component of this.assistants.keys()) {
      component.setTurnWorkCollapsed?.(collapsed);
      component.setHideProgress?.(collapsed);
    }
    for (const group of this.toolGroups) group.setTurnWorkCollapsed?.(collapsed);
    this.ui.requestRender();
  }

  setRequestCompleted(completed, terminalStatus) {
    this.requestCompleted = Boolean(completed);
    if (terminalStatus) this.terminalStatus = terminalStatus;
    this.applyPresentation();
  }

  trackAssistant(component, message) {
    this.assistants.set(component, message);
    if (this.requestCompleted) this.applyPresentation();
  }

  trackToolGroup(group) {
    this.toolGroups.add(group);
    if (this.requestCompleted) this.applyPresentation();
  }

  setExpanded(expanded) {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.applyPresentation();
  }

  render(width) {
    let steps = 0;
    let thoughtMs = 0;
    for (const message of this.assistants.values()) {
      const stats = thinkingStats(message);
      steps += stats.steps;
      thoughtMs += stats.thoughtMs;
    }
    let tools = 0;
    for (const group of this.toolGroups) tools += group.size;
    let progress = 0;
    for (const message of this.assistants.values()) {
      for (const content of message?.content ?? []) {
        if (content.type !== "text" || !content.text?.trim()) continue;
        if (isToolUseEllipsisFiller(message, content)) continue;
        if (phaseForTextContent(content, message) === "progress") {
          progress += 1;
        }
      }
    }
    if (steps === 0 && tools === 0 && progress === 0) return [];
    // Some providers never expose reasoning as thinking blocks, and then
    // "Worked 0 steps" is the loudest and least true part of the line.
    const parts = [];
    if (steps > 0) parts.push(`Worked ${steps} ${steps === 1 ? "step" : "steps"}`);
    if (progress > 0) parts.push(`${progress} ${progress === 1 ? "update" : "updates"}`);
    if (thoughtMs > 0) parts.push(`thought ${compactDuration(thoughtMs)}`);
    if (tools > 0) parts.push(`${tools} ${tools === 1 ? "tool" : "tools"}`);
    const status = this.terminalStatus === "interrupted" ? "Interrupted" : this.terminalStatus === "failed" ? "Failed" : undefined;
    const head = `  • ${parts.join(" · ")}${status ? ` · ${status}` : ""}`;
    const names = compactTools(this.toolGroups, Math.max(0, width - [...head].length - 2));
    const line = truncateToWidth(theme.fg("dim", `${head}${names ? `: ${names}` : ""}`), width, "");
    this.mouseLayout = undefined;
    return ["", line];
  }

  handleMouse(event) {
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.setExpanded(!this.expanded);
    return { handled: true };
  }
}
