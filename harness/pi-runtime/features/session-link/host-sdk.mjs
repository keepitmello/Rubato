import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export { getMarkdownTheme } from "@earendil-works/pi-coding-agent";

// Follow the selected coding-agent package's own pi-tui, as media-tools/src/host-sdk.mjs does:
// resolving from the coding-agent entry finds its nested copy (0.86.1) or hoisted sibling (1.0.1).
const codingAgentEntry = pathToFileURL(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const piTuiDir = dirname(findPackageJSON("@earendil-works/pi-tui", codingAgentEntry));
const piTui = await import(pathToFileURL(join(piTuiDir, "dist/index.js")).href);

export const Box = piTui.Box;
export const Markdown = piTui.Markdown;
export const Spacer = piTui.Spacer;
export const Text = piTui.Text;
