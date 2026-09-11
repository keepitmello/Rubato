import { HistorySearchOverlay } from "./overlay.mjs";
import { historySearchRoot, iterateHistoryCatalogPages } from "./catalog-index.mjs";

export function createHistorySearchExtension() {
  return (pi) => {
    pi.registerCommand("history", {
      description: "Search prompt history across sessions",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("No UI available", "info");
          return;
        }
        const { searchRoot, includeSubdirectories } = historySearchRoot(ctx.sessionManager);
        if (!searchRoot) {
          ctx.ui.notify("No prompt history found", "info");
          return;
        }
        const pages = iterateHistoryCatalogPages({ root: searchRoot, includeSubdirectories });
        let first;
        try {
          first = await pages.next();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify("Failed to read prompt history: " + message, "error");
          return;
        }
        if (first.done || !first.value?.entries?.length) {
          ctx.ui.notify("No prompt history found", "info");
          return;
        }
        const selected = await ctx.ui.custom(
          (tui, theme, keybindings, done) => {
            const overlay = new HistorySearchOverlay({ tui, entries: first.value.entries, theme, keybindings, done });
            if (first.value.hasMore) {
              void (async () => {
                try {
                  for await (const page of pages) overlay.setEntries(page.entries);
                } catch {
                  // Overlay may already have closed.
                }
              })();
            }
            return overlay;
          },
          { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", minWidth: 60, margin: 2 } },
        );
        if (selected) ctx.ui.setEditorText(selected.text);
      },
    });
  };
}

export default createHistorySearchExtension;
