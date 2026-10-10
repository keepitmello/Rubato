import { isAbsolute, relative, resolve } from "node:path";
export const GENERATED_IMAGE_DIRECTORY = "generated-images";
const DEFAULT_DIRECTORY = GENERATED_IMAGE_DIRECTORY;
const MAX_TOOL_CALL_ID_CHARS = 64;
/**
 * Reduces a provider-supplied identifier to a safe file stem: path separators and
 * any other unexpected character collapse to `_`, the result is length-capped, and
 * an identifier that sanitizes to nothing falls back to `image`.
 */
export function sanitizeImageStem(identifier) {
    const sanitized = identifier.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_TOOL_CALL_ID_CHARS);
    return sanitized.length > 0 ? sanitized : "image";
}
function sanitizeToolCallId(toolCallId) {
    return sanitizeImageStem(toolCallId);
}
/**
 * Resolves the absolute destination path for a generation call.
 *
 * A relative output_path resolves against the working directory. An omitted path
 * falls back to generated-images/<sanitized tool call id>.png. An extensionless
 * path gains .png; any other extension is rejected.
 */
export function resolveTarget(cwd, toolCallId, outputPath) {
    const requested = outputPath?.trim();
    if (requested === undefined || requested.length === 0) {
        return { ok: true, path: resolve(cwd, DEFAULT_DIRECTORY, `${sanitizeToolCallId(toolCallId)}.png`) };
    }
    const absolute = isAbsolute(requested) ? requested : resolve(cwd, requested);
    const extensionMatch = /\.[^./\\]+$/.exec(absolute);
    if (extensionMatch && extensionMatch[0].toLowerCase() !== ".png") {
        return { ok: false, error: `Error: output_path must end in .png (got "${requested}").` };
    }
    return { ok: true, path: extensionMatch ? absolute : `${absolute}.png` };
}
/** Prefers a path relative to the working directory, falling back to absolute. */
export function displayPath(cwd, absolute) {
    const relativePath = relative(cwd, absolute);
    return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : absolute;
}
