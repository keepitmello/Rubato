import {
	getImagesApiProvider,
	registerImagesApiProvider,
} from "../host-sdk.mjs";
import { generateImages } from "./api/openai-images.js";

export const OPENAI_IMAGES_API = "openai-images";
export const OPENAI_IMAGES_SOURCE_ID = "rubato-media-tools:openai-images@2026.9.4-3";

/** Install the exact Senpi OpenAI images provider in stock Pi's compat registry. */
export function registerOpenAIImagesApiProvider() {
	registerImagesApiProvider(
		{ api: OPENAI_IMAGES_API, generateImages },
		OPENAI_IMAGES_SOURCE_ID,
	);
	return getImagesApiProvider(OPENAI_IMAGES_API);
}

export { generateImages as generateOpenAIImages };
