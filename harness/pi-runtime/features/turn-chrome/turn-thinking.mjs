// One Thinking... toggle for the whole turn. Expanding it shows every thinking
// block in order; leaving it open appends new thinking as it streams in.
import { Container, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/interactive/theme/theme.js";

export class TurnThinkingComponent extends Container {
  constructor(ui, options = {}) {
    super();
    this.ui = ui;
    this.collapsed = options.collapsed !== false;
    this.outputPad = options.outputPad ?? 1;
    this.markdownTheme = options.markdownTheme ?? getMarkdownTheme();
    this.messages = new Map();
    this.turnWorkCollapsed = false;
  }

  setTurnWorkCollapsed(collapsed) {
    this.turnWorkCollapsed = collapsed;
  }

  trackAssistant(component, message) {
    this.messages.set(component, message);
    this.ui.requestRender();
  }

  thinkingParts() {
    const parts = [];
    for (const message of this.messages.values()) {
      for (const content of message?.content ?? []) {
        if (content?.type !== "thinking") continue;
        const text = String(content.thinking ?? "").trim();
        if (text) parts.push(text);
      }
    }
    return parts;
  }

  render(width) {
    if (this.turnWorkCollapsed) return [];
    const parts = this.thinkingParts();
    if (parts.length === 0) return [];
    this.mouseLayout = undefined;
    if (this.collapsed) {
      return [theme.italic(theme.fg("thinkingText", "Thinking..."))];
    }
    return new Markdown(parts.join("\n\n"), this.outputPad, 0, this.markdownTheme, {
      color: (text) => theme.fg("thinkingText", text),
      italic: true,
    }).render(width);
  }

  handleMouse(event) {
    if (this.turnWorkCollapsed) return undefined;
    if (event.type !== "click" || event.button !== "left") return undefined;
    if (this.thinkingParts().length === 0) return undefined;
    this.collapsed = !this.collapsed;
    this.ui.requestRender();
    return { handled: true };
  }
}
