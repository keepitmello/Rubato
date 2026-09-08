import imageGenExtension from "./imagegen/index.js";
import { registerOpenAIImagesApiProvider } from "./openai-images/index.mjs";
import openaiImageGenExtension from "./openai-image-gen/index.js";
import openaiWebSearchExtension from "./openai-web-search/index.js";
import webfetchExtension, { isWebfetchEnabled } from "./webfetch/index.js";
import lookAtExtension from "./look-at/index.js";

export {
	imageGenExtension,
	isWebfetchEnabled,
	lookAtExtension,
	openaiImageGenExtension,
	openaiWebSearchExtension,
	webfetchExtension,
};

export function registerMediaTools(pi, host = {}) {
	registerOpenAIImagesApiProvider();
	webfetchExtension(pi);
	lookAtExtension(pi, host);
	imageGenExtension(pi);
	// Preserve Senpi ordering: native arbitration observes the registered client tool.
	openaiImageGenExtension(pi);
	openaiWebSearchExtension(pi);
}

export default registerMediaTools;
