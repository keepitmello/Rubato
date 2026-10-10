import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export {
	convertToPng,
	defineTool,
	formatDimensionNote,
	resizeImage,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Follow the selected coding-agent package's validated dependency edges. The runtime
// resolver rejects mixed identities before features load; never fall back to Senpi,
// global modules, HOME, or the original checkout.
// Resolving from the coding-agent entry finds its nested copy (0.86.1 layout) or the hoisted
// sibling (1.0.1 layout) exactly as the coding agent itself does.
const codingAgentEntry = pathToFileURL(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const packageDirOf = (name) => dirname(findPackageJSON(name, codingAgentEntry));
const piAiDir = packageDirOf("@earendil-works/pi-ai");
const piTuiDir = packageDirOf("@earendil-works/pi-tui");
const piAi = await import(pathToFileURL(join(piAiDir, "dist/index.js")).href);
const piTui = await import(pathToFileURL(join(piTuiDir, "dist/index.js")).href);

export const StringEnum = piAi.StringEnum;
export const Text = piTui.Text;
export const truncateToWidth = piTui.truncateToWidth;
