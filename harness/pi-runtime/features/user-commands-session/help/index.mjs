import { APP_NAME } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import { buildHelpMarkdown } from "./markdown.mjs";
import { HELP_OVERLAY_OPTIONS, HelpPanel } from "./panel.mjs";

const NON_TUI_HELP = "Interactive /help is available in TUI mode; run " + APP_NAME + " --help for CLI usage.";

export function createHelpExtension() {
  return (pi) => {
    pi.registerCommand("help", {
      description: "Show usage, keybindings, and all commands",
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(NON_TUI_HELP, "info");
          return;
        }
        await ctx.ui.custom((tui, theme, keybindings, done) => {
          const markdown = buildHelpMarkdown({ extensionCommands: pi.getCommands(), keybindings });
          return new HelpPanel({ markdown, tui, theme, keybindings, done });
        }, { overlay: true, overlayOptions: HELP_OVERLAY_OPTIONS });
      },
    });
  };
}

export default createHelpExtension;
