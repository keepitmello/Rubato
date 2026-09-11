import { Text } from "../tui.mjs";

export function createRedrawsExtension() {
  return (pi) => {
    pi.registerCommand("tui", {
      description: "Show TUI stats",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) return;
        let redraws = 0;
        await ctx.ui.custom((tui, _theme, _keybindings, done) => {
          redraws = tui.fullRedraws ?? 0;
          done(undefined);
          return new Text("", 0, 0);
        });
        ctx.ui.notify("TUI full redraws: " + redraws, "info");
      },
    });
  };
}

export default createRedrawsExtension;
