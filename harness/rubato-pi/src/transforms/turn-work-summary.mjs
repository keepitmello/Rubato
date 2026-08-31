// In-repo TurnWorkSummaryComponent at the fully-patched final state
// (#18 + #22 tool status + #23 width + #30 aggregate).
// Vendor `turn-work-summary.js` is a created file — importers are rewritten to this href.
import { pathToFileURL } from "node:url";
import { senpiDir, senpiNested } from "../engine-paths.mjs";
import { registerInternalAction } from "./internal-actions.mjs";

const { Container, hyperlink, truncateToWidth } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-tui/dist/index.js")).href
);
const { theme } = await import(
  pathToFileURL(`${senpiDir}/dist/modes/interactive/theme/theme.js`).href
);

export function turnWorkSummaryHref() {
  return import.meta.url;
}

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
    if (Number.isFinite(minStart))
      thoughtMs += Math.max(0, (Number.isFinite(maxEnd) ? maxEnd : now) - minStart);
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
      const key = `${item.failed ? "1" : "0"}\0${item.name}`;
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
    this.toggleAction = registerInternalAction(() => {
      this.setExpanded(!this.expanded);
      this.ui.requestRender();
    });
  }
  trackAssistant(component, message) {
    this.assistants.set(component, message);
    component.setTurnWorkCollapsed?.(!this.expanded);
    this.invalidate();
  }
  trackToolGroup(group) {
    this.toolGroups.add(group);
    group.setTurnWorkCollapsed?.(!this.expanded);
    this.invalidate();
  }
  setExpanded(expanded) {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    for (const component of this.assistants.keys()) component.setTurnWorkCollapsed?.(!expanded);
    for (const group of this.toolGroups) group.setTurnWorkCollapsed?.(!expanded);
    this.invalidate();
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
    if (steps === 0 && tools === 0) return [];
    const parts = [`Worked ${steps} ${steps === 1 ? "step" : "steps"}`];
    if (thoughtMs > 0) parts.push(`thought ${compactDuration(thoughtMs)}`);
    if (tools > 0) parts.push(`${tools} ${tools === 1 ? "tool" : "tools"}`);
    const head = `• ${parts.join(" · ")}`;
    const names = compactTools(this.toolGroups, Math.max(0, width - [...head].length - 2));
    const line = truncateToWidth(`${head}${names ? `: ${names}` : ""}`, width, "");
    return [hyperlink(theme.fg("dim", line), this.toggleAction.url)];
  }
  dispose() {
    this.toggleAction.dispose();
    super.dispose();
  }
}
