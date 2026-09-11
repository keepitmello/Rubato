import { basename } from "node:path";
import { Container, DynamicBorder, Input, SelectList, Text } from "../tui.mjs";
import { filterHistory } from "./filter.mjs";

const MAX_VISIBLE_ROWS = 15;
const MAX_RENDERED_MATCHES = 250;
const SELECT_LIST_ACTIONS = [
  "tui.select.up",
  "tui.select.down",
  "tui.select.confirm",
  "tui.select.cancel",
];

function relativeTime(timestamp, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "d ago";
  const months = Math.floor(days / 30);
  if (months < 12) return months + "mo ago";
  return Math.floor(months / 12) + "y ago";
}

function describeEntry(entry) {
  const shortId = entry.sessionId.length <= 8 ? entry.sessionId : entry.sessionId.slice(0, 8);
  const cwdName = basename(entry.cwd);
  const sessionLabel = cwdName ? cwdName + "/" + shortId : shortId;
  return sessionLabel + " · " + relativeTime(entry.timestamp);
}

export class HistorySearchOverlay extends Container {
  constructor(options) {
    super();
    this.entriesByValue = new Map();
    this.filteredEntries = [];
    this._focused = false;
    this.options = options;
    this.searchInput = new Input();
    this.searchInput.onEscape = () => this.options.done(undefined);
    this.rebuild();
  }

  get focused() {
    return this._focused;
  }

  set focused(value) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  handleInput(input) {
    const keybindings = this.options.keybindings;
    if (keybindings && SELECT_LIST_ACTIONS.some((action) => keybindings.matches(input, action))) {
      this.list?.handleInput(input);
      return;
    }
    const before = this.searchInput.getValue();
    this.searchInput.handleInput(input);
    if (before !== this.searchInput.getValue()) {
      this.rebuild();
      this.options.tui.requestRender();
    }
  }

  getSearchValue() {
    return this.searchInput.getValue();
  }

  getFilteredEntries() {
    return this.filteredEntries;
  }

  setEntries(entries) {
    this.options.entries = entries;
    this.rebuild();
    this.options.tui?.requestRender?.();
  }

  rebuild() {
    this.entriesByValue.clear();
    this.filteredEntries = filterHistory(this.options.entries, this.searchInput.getValue());
    const renderedEntries = this.filteredEntries.slice(0, MAX_RENDERED_MATCHES);
    const items = renderedEntries.map((entry, index) => this.toSelectItem(entry, index));
    const list = new SelectList(items, Math.min(MAX_VISIBLE_ROWS, Math.max(1, items.length)), {
      selectedPrefix: (text) => this.options.theme.fg("accent", text),
      selectedText: (text) => text,
      description: (text) => this.options.theme.fg("muted", text),
      scrollInfo: (text) => this.options.theme.fg("dim", text),
      noMatch: (text) => this.options.theme.fg("warning", text.replace("commands", "prompts")),
    });
    list.onSelect = (item) => this.options.done(this.entriesByValue.get(item.value));
    list.onCancel = () => this.options.done(undefined);
    this.list = list;
    this.renderContainer(list, this.filteredEntries.length);
  }

  toSelectItem(entry, index) {
    const value = String(index);
    this.entriesByValue.set(value, entry);
    return {
      value,
      label: entry.text.replace(/[\r\n]+/g, " ").trim(),
      description: describeEntry(entry),
    };
  }

  renderContainer(list, matchCount) {
    const title = this.options.theme.fg("accent", this.options.theme.bold(" Search prompt history"));
    const count = this.options.theme.fg("dim", " " + matchCount + "/" + this.options.entries.length + " prompts");
    this.clear();
    this.addChild(new DynamicBorder((text) => this.options.theme.fg("accent", text)));
    this.addChild(new Text(title + count, 0, 0));
    this.addChild(this.searchInput);
    this.addChild(list);
    this.addChild(new Text(this.options.theme.fg("dim", " Type to filter • ↑↓ navigate • enter select • esc close"), 0, 0));
    this.addChild(new DynamicBorder((text) => this.options.theme.fg("accent", text)));
  }
}
