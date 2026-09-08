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
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const codingAgentDir = dirname(dirname(codingAgentEntry));
const piAi = await import(
	pathToFileURL(join(codingAgentDir, "node_modules/@earendil-works/pi-ai/dist/index.js")).href
);
const piAiCompat = await import(
	pathToFileURL(join(codingAgentDir, "node_modules/@earendil-works/pi-ai/dist/compat.js")).href
);
const piTui = await import(
	pathToFileURL(join(codingAgentDir, "node_modules/@earendil-works/pi-tui/dist/index.js")).href
);

export const StringEnum = piAi.StringEnum;
export const Text = piTui.Text;
export const truncateToWidth = piTui.truncateToWidth;
export const generateImages = piAiCompat.generateImages;
export const getImagesApiProvider = piAiCompat.getImagesApiProvider;
export const registerImagesApiProvider = piAiCompat.registerImagesApiProvider;
