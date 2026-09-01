import { replaceOnce } from "./misc-replace.mjs";

export function isTransformMessagesUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/transform-messages.js");
}

export function isGoogleSharedUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/google-shared.js");
}

const TRANSFORM_NEEDLE = "    const supportsImages = model.input.includes(\"image\");\n    const supportsVideo = model.input.includes(\"video\");";
const TRANSFORM_REPLACEMENT = "    const supportsImages = model.input?.includes(\"image\") === true;\n    const supportsVideo = model.input?.includes(\"video\") === true;";

const GOOGLE_NEEDLE = "            const imageContent = model.input.includes(\"image\")";
const GOOGLE_REPLACEMENT = "            const imageContent = model.input?.includes(\"image\")";

/**
 * pinned encoder 는 매 요청마다 `model.input.includes(...)` 를 가드 없이 읽는다.
 * catalog 가 `input` 을 빼먹으면 첫 user 턴에서도 TypeError 로 빈다.
 */
export function injectTransformMessagesInputGuard(source) {
  return replaceOnce(source, TRANSFORM_NEEDLE, TRANSFORM_REPLACEMENT, "transform-messages input guard");
}

export function injectGoogleSharedInputGuard(source) {
  return replaceOnce(source, GOOGLE_NEEDLE, GOOGLE_REPLACEMENT, "google-shared input guard");
}
