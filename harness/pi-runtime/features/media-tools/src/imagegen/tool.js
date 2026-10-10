import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { defineTool } from "../host-sdk.mjs";
import { latestImageResult, nextChain } from "./chain.js";
import { CODEX_PROVIDER, composePrompt, generateCodexImage, IMAGE_MODELS, ORCHESTRATOR_MODEL_ID, resolveCodexImageModel } from "./codex.js";
import { displayPath, resolveTarget } from "./paths.js";

export const IMAGE_CREATE_TOOL_NAME = "image_create";
export const IMAGE_EDIT_TOOL_NAME = "image_edit";
const IMAGE_TOOL_NAMES = [IMAGE_CREATE_TOOL_NAME, IMAGE_EDIT_TOOL_NAME];
const MAX_INPUT_IMAGES = 10;
const INPUT_MIME_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

const shared = {
    prompt: Type.String({ minLength: 1, maxLength: 32_000, description: "Detailed description of the image, or of the change to make." }),
    size: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("1024x1024"), Type.Literal("1024x1536"), Type.Literal("1536x1024")], { default: "auto", description: "Output resolution. Defaults to auto." })),
    quality: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { default: "auto", description: "Rendering quality. Defaults to auto." })),
    output_path: Type.Optional(Type.String({ minLength: 1, description: "Where to write the PNG, relative to the working directory. Defaults to generated-images/." })),
};
const CreateParams = Type.Object(shared, { additionalProperties: false });
const EditParams = Type.Object({
    ...shared,
    images: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_INPUT_IMAGES,
        description: "Image files to edit or follow as reference. Omit to keep editing the last image made in this session.",
    })),
}, { additionalProperties: false });

function failure(message, reason, base) {
    return { content: [{ type: "text", text: message }], details: { ...base, error: message, reason } };
}

async function readInputImage(cwd, path) {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    const mimeType = INPUT_MIME_TYPES[extname(absolute).toLowerCase()];
    if (mimeType === undefined)
        return { ok: false, error: `Error: ${path} is not a PNG, JPEG, WebP or GIF image.` };
    try {
        return { ok: true, absolute, image: { data: (await readFile(absolute)).toString("base64"), mimeType } };
    }
    catch (error) {
        return { ok: false, error: `Error: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
}

/** Picks the edit source: explicit images start a new chain, none continues the session's last image. */
async function editSources(params, ctx) {
    if (params.images !== undefined) {
        const loaded = [];
        for (const path of params.images) {
            const input = await readInputImage(ctx.cwd, path);
            if (!input.ok)
                return input;
            loaded.push(input);
        }
        return { ok: true, inputs: loaded, history: [] };
    }
    const previous = latestImageResult(ctx.sessionManager, IMAGE_TOOL_NAMES);
    if (previous === undefined)
        return { ok: false, error: "Error: no earlier image in this session to continue. Pass `images`, or make one with image_create first." };
    const input = await readInputImage(ctx.cwd, previous.absolutePath);
    if (!input.ok)
        return { ok: false, error: `Error: the last image ${previous.path} is no longer readable. Pass \`images\` instead.` };
    return { ok: true, inputs: [input], history: previous.chain, continued: true };
}

async function runImageTool(kind, toolCallId, params, signal, ctx) {
    const imageModel = IMAGE_MODELS[kind];
    const size = params.size ?? "auto";
    const quality = params.quality ?? "auto";
    const base = { tool: kind === "create" ? IMAGE_CREATE_TOOL_NAME : IMAGE_EDIT_TOOL_NAME, imageModel, orchestrator: `${CODEX_PROVIDER}/${ORCHESTRATOR_MODEL_ID}`, size, quality };
    const prompt = params.prompt.trim();
    if (prompt.length === 0)
        return failure("Error: prompt must contain non-whitespace text.", "invalid_params", base);
    const resolved = resolveCodexImageModel(ctx.modelRegistry);
    if (!resolved.ok)
        return failure(resolved.reason, "missing_config", base);
    const target = resolveTarget(ctx.cwd, toolCallId, params.output_path);
    if (!target.ok)
        return failure(target.error, "invalid_params", base);
    const absolutePath = target.path;
    if (existsSync(absolutePath))
        return failure(`Error: ${displayPath(ctx.cwd, absolutePath)} already exists. Choose another output_path.`, "invalid_params", base);
    const sources = kind === "edit" ? await editSources(params, ctx) : { ok: true, inputs: [], history: [] };
    if (!sources.ok)
        return failure(sources.error, "invalid_params", base);
    const result = await generateCodexImage({
        registry: ctx.modelRegistry,
        model: resolved.model,
        imageModel,
        prompt: composePrompt(prompt, sources.history),
        images: sources.inputs.map((input) => input.image),
        size,
        quality,
        signal,
    });
    if (!result.ok)
        return failure(`Error: ${result.message}`, result.reason, base);
    try {
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, Buffer.from(result.data, "base64"), { flag: "wx" });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return failure(`Error: failed to write the image to ${displayPath(ctx.cwd, absolutePath)}: ${reason}`, "write_failed", base);
    }
    const path = displayPath(ctx.cwd, absolutePath);
    const details = {
        ...base,
        path,
        absolutePath,
        inputs: sources.inputs.map((input) => displayPath(ctx.cwd, input.absolute)),
        continued: sources.continued === true,
        prompt,
        ...(result.revisedPrompt === undefined ? {} : { revisedPrompt: result.revisedPrompt }),
        chain: nextChain(sources.history, { prompt }),
    };
    const summary = [
        `Saved ${path} (${imageModel}).`,
        ...(details.continued ? [`Continued from ${details.inputs[0]}.`] : []),
        ...(result.revisedPrompt === undefined ? [] : [`Revised prompt: ${result.revisedPrompt}`]),
    ].join("\n");
    return {
        content: [{ type: "text", text: summary }, { type: "image", data: result.data, mimeType: "image/png" }],
        details,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
}

export const imageCreateTool = defineTool({
    name: IMAGE_CREATE_TOOL_NAME,
    label: "Create Image",
    description: "Create a new image from a text prompt with ChatGPT Images 2.5 Flare, the fast tier, and save it as a PNG. To change an existing image, use image_edit. Runs on the OpenAI ChatGPT login only.",
    promptSnippet: "Create new images from text prompts (ChatGPT Images 2.5 Flare).",
    parameters: CreateParams,
    execute: (toolCallId, params, signal, _onUpdate, ctx) => runImageTool("create", toolCallId, params, signal, ctx),
});

export const imageEditTool = defineTool({
    name: IMAGE_EDIT_TOOL_NAME,
    label: "Edit Image",
    description: "Edit or continue an image with ChatGPT Images 2.5 Sunburst, the precise-editing tier, and save the result as a new PNG. Pass `images` to edit or reference specific files; omit it to keep editing the last image made in this session, with the earlier requests carried along. Runs on the OpenAI ChatGPT login only.",
    promptSnippet: "Edit or continue images (ChatGPT Images 2.5 Sunburst).",
    parameters: EditParams,
    execute: (toolCallId, params, signal, _onUpdate, ctx) => runImageTool("edit", toolCallId, params, signal, ctx),
});
