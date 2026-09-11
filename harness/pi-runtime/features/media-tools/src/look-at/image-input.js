import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { processImage } from "../host/image-process.mjs";
export const IMAGE_ATTACHMENT_REFERENCE_REGEX = /^\s*(?:\[?Image #([1-9]\d*)(?:,[^\]\n]*)?\]?|(?:attachment|image):\/\/([1-9]\d*))\s*$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const EXTENSION_MIME_TYPES = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webp": "image/webp",
};
export function parseImageAttachmentReference(input) {
    const match = IMAGE_ATTACHMENT_REFERENCE_REGEX.exec(input);
    const rawIndex = match?.[1] ?? match?.[2];
    return rawIndex ? { index: Number(rawIndex) } : null;
}
function detectMimeType(bytes) {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        return "image/png";
    if (startsWith(bytes, [0xff, 0xd8, 0xff]))
        return "image/jpeg";
    if (startsWithAscii(bytes, 0, "GIF8"))
        return "image/gif";
    if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP"))
        return "image/webp";
    if (startsWithAscii(bytes, 0, "%PDF-"))
        return "application/pdf";
    return undefined;
}
function startsWith(bytes, signature) {
    return signature.every((byte, index) => bytes[index] === byte);
}
function startsWithAscii(bytes, offset, text) {
    return text.split("").every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}
function mimeTypeFromName(name) {
    return EXTENSION_MIME_TYPES[extname(name).toLowerCase()];
}
function parseBase64(input) {
    const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/is.exec(input);
    return match ? { data: match[2], mimeType: match[1].toLowerCase() } : { data: input, mimeType: undefined };
}
function decodeBase64(input) {
    const data = Buffer.from(input, "base64");
    if (data.length === 0 && input.trim().length > 0) {
        throw new Error("Error: Could not decode base64 input.");
    }
    return data;
}
function lastUserImages(ctx) {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry.type !== "message" || entry.message.role !== "user")
            continue;
        return Array.isArray(entry.message.content)
            ? entry.message.content.filter((block) => block.type === "image")
            : [];
    }
    return [];
}
function availableAttachmentError(input, images) {
    if (images.length === 0) {
        return new Error(`Error: No image attachments are available in this turn. "${input}" must be a readable file path or attachment URI.`);
    }
    const available = images.map((_, index) => `Image #${index + 1} -> attachment://${index + 1}`).join(", ");
    return new Error(`Error: Could not resolve image attachment '${input}'. Available image attachments: ${available}.`);
}
async function finalizeInput(ctx, input) {
    if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error("Error: Input exceeds the 10MiB per-image limit.");
    }
    const mimeType = detectMimeType(input.bytes) ?? input.mimeType;
    if (!mimeType)
        throw new Error(`Error: Could not determine MIME type for ${input.label}.`);
    if (!mimeType.startsWith("image/") || !ctx.getImageSettings().autoResize) {
        return {
            data: Buffer.from(input.bytes).toString("base64"),
            inputBytes: input.bytes.byteLength,
            label: input.label,
            mimeType,
        };
    }
    const processed = await processImage(input.bytes, mimeType, { autoResizeImages: true });
    if (!processed.ok)
        throw new Error(`Error: Could not process image ${input.label}: ${processed.message}`);
    return {
        data: processed.data,
        inputBytes: input.bytes.byteLength,
        label: input.label,
        mimeType: processed.mimeType,
    };
}
async function loadPathInput(ctx, input) {
    if (/^https?:\/\//i.test(input)) {
        throw new Error("Error: Remote URLs are not supported; download first, use local path.");
    }
    const reference = parseImageAttachmentReference(input);
    if (reference) {
        const images = lastUserImages(ctx);
        const image = images[reference.index - 1];
        if (!image)
            throw availableAttachmentError(input, images);
        return finalizeInput(ctx, {
            bytes: decodeBase64(image.data),
            label: `Image #${reference.index}`,
            mimeType: image.mimeType.toLowerCase(),
        });
    }
    const path = isAbsolute(input) ? input : resolve(ctx.cwd, input);
    try {
        return await finalizeInput(ctx, {
            bytes: await readFile(path),
            label: basename(path),
            mimeType: mimeTypeFromName(path),
        });
    }
    catch (error) {
        if (isErrno(error, "ENOENT"))
            throw new Error(`Error: File not found: ${input}`);
        throw error;
    }
}
function isErrno(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
}
export async function loadLookAtInputs(ctx, paths, base64Inputs) {
    if (ctx.getImageSettings().blockImages)
        throw new Error("Error: Image inputs are blocked by settings.");
    const loaded = await Promise.all([
        ...paths.map((path) => loadPathInput(ctx, path)),
        ...base64Inputs.map(async (input) => {
            const base64 = parseBase64(input);
            return finalizeInput(ctx, {
                bytes: decodeBase64(base64.data),
                label: "base64 input",
                mimeType: base64.mimeType,
            });
        }),
    ]);
    const totalBytes = loaded.reduce((total, input) => total + input.inputBytes, 0);
    if (totalBytes > MAX_TOTAL_BYTES)
        throw new Error("Error: Inputs exceed the 25MiB aggregate limit.");
    return loaded.map(({ inputBytes: _, ...input }) => input);
}
//# sourceMappingURL=image-input.js.map
