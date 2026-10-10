import imageGenExtension from "./imagegen/index.js";
import openaiWebSearchExtension from "./openai-web-search/index.js";
import anthropicBashExtension from "./anthropic-bash/index.js";
import webfetchExtension, { isWebfetchEnabled } from "./webfetch/index.js";
import lookAtExtension from "./look-at/index.js";
import { installImageLimit } from "./host/image-limit.mjs";

export {
	imageGenExtension,
	isWebfetchEnabled,
	lookAtExtension,
	openaiWebSearchExtension,
	anthropicBashExtension,
	webfetchExtension,
};

export function registerMediaTools(pi, host = {}) {
	installImageLimit(pi);
	webfetchExtension(pi);
	lookAtExtension(pi, host);
	imageGenExtension(pi);
	openaiWebSearchExtension(pi);
	anthropicBashExtension(pi);
}

export default registerMediaTools;
