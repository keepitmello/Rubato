import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { displayPath, GENERATED_IMAGE_DIRECTORY, sanitizeImageStem } from "../imagegen/paths.js";

export const IMAGE_GENERATION_CALL_SUBTYPE = "image_generation_call";
const MAX_COLLISION_ATTEMPTS = 100;

function readString(record, key) {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

export function readCompletedNativeImage(raw) {
    if (typeof raw !== "object" || raw === null)
        return undefined;
    const record = { ...raw };
    if (readString(record, "type") !== IMAGE_GENERATION_CALL_SUBTYPE)
        return undefined;
    if (readString(record, "status") !== "completed")
        return undefined;
    const result = readString(record, "result");
    if (result === undefined || result.length === 0)
        return undefined;
    const id = readString(record, "id");
    const revisedPrompt = readString(record, "revised_prompt");
    return {
        ...(id === undefined ? {} : { id }),
        result,
        ...(revisedPrompt?.trim() ? { revisedPrompt } : {}),
    };
}

export function detectImageExtension(bytes) {
    if (bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "jpg";
    }
    if (bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP") {
        return "webp";
    }
    return "png";
}

function fileStem(image, responseId, outputIndex) {
    if (image.id !== undefined)
        return sanitizeImageStem(image.id);
    return sanitizeImageStem(`${responseId ?? "image"}-${outputIndex}`);
}

function decodeBase64(result) {
    const bytes = Buffer.from(result, "base64");
    if (bytes.length === 0)
        throw new Error("decoded to zero bytes");
    return bytes;
}

async function writeWithoutOverwrite(directory, stem, extension, bytes) {
    await mkdir(directory, { recursive: true });
    for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
        const suffix = attempt === 1 ? "" : `-${attempt}`;
        const target = join(directory, `${stem}${suffix}.${extension}`);
        try {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, bytes, { flag: "wx" });
            return target;
        }
        catch (error) {
            const code = error instanceof Error && "code" in error ? error.code : undefined;
            if (code !== "EEXIST")
                throw error;
        }
    }
    throw new Error(`no free filename for ${stem}.${extension}`);
}

function successText(cwd, target, revisedPrompt) {
    const lines = [`Generated image: ${displayPath(cwd, target)}`];
    if (revisedPrompt !== undefined)
        lines.push(`Revised prompt: ${revisedPrompt}`);
    return { type: "text", text: lines.join("\n") };
}

function failureText(reason) {
    return { type: "text", text: `Generated image could not be saved: ${reason}.` };
}

async function externalizeBlock(cwd, image, responseId, outputIndex) {
    try {
        const bytes = decodeBase64(image.result);
        const target = await writeWithoutOverwrite(join(cwd, GENERATED_IMAGE_DIRECTORY), fileStem(image, responseId, outputIndex), detectImageExtension(bytes), bytes);
        return successText(cwd, target, image.revisedPrompt);
    }
    catch (error) {
        return failureText(error instanceof Error ? error.message : String(error));
    }
}

function isImageGenerationCall(block) {
    return block.type === "providerNative" && block.subtype === IMAGE_GENERATION_CALL_SUBTYPE;
}

export async function externalizeNativeImages(message, cwd) {
    const content = [];
    let replaced = false;
    for (const [outputIndex, block] of message.content.entries()) {
        const image = isImageGenerationCall(block) ? readCompletedNativeImage(block.raw) : undefined;
        if (image === undefined) {
            content.push(block);
            continue;
        }
        content.push(await externalizeBlock(cwd, image, message.responseId, outputIndex));
        replaced = true;
    }
    return replaced ? { ...message, content } : undefined;
}
