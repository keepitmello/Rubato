import { processImage } from "./image-process.mjs";

/** Anthropic many-image requests (>20 image/document blocks) reject any side over this. */
export const MANY_IMAGE_MAX_DIMENSION = 2000;

/**
 * Anthropic downsizes any image whose long side is over 1568px before the model sees it, so
 * pixels past that are bytes the session carries for nothing. A tool-result screenshot is
 * stored once and re-sent on every later turn: 22 PNG screenshots were 22.6MB in one session,
 * and 5.0MB as 1568px JPEG. Bigger histories cross the request byte cap, and trimming old
 * images to fit changes the prompt prefix and throws away the cache.
 */
export const STORED_IMAGE_MAX_DIMENSION = 1568;
/** Base64 characters. Screenshots land well under this as JPEG and well over it as PNG. */
export const STORED_IMAGE_MAX_BASE64 = 512 * 1024;

export function isVideoMimeType(mimeType) {
	return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("video/");
}

export function readImageDimensions(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24) return null;
	return readPngDimensions(bytes) ?? readJpegDimensions(bytes) ?? readGifDimensions(bytes) ?? readWebpDimensions(bytes);
}

function readU16be(bytes, offset) {
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU16le(bytes, offset) {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU24le(bytes, offset) {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32be(bytes, offset) {
	return bytes[offset] * 2 ** 24 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
}

function ascii(bytes, offset, length) {
	return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readPngDimensions(bytes) {
	if (bytes[0] !== 0x89 || ascii(bytes, 1, 3) !== "PNG") return null;
	if (ascii(bytes, 12, 4) !== "IHDR") return null;
	const width = readU32be(bytes, 16);
	const height = readU32be(bytes, 20);
	if (width < 1 || height < 1) return null;
	return { width, height };
}

function readJpegDimensions(bytes) {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 8 < bytes.byteLength) {
		if (bytes[offset] !== 0xff) return null;
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset += 1;
			continue;
		}
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		const length = readU16be(bytes, offset + 2);
		if (length < 2) return null;
		const isSof =
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf);
		if (isSof && offset + 8 < bytes.byteLength) {
			const height = readU16be(bytes, offset + 5);
			const width = readU16be(bytes, offset + 7);
			if (width < 1 || height < 1) return null;
			return { width, height };
		}
		offset += 2 + length;
	}
	return null;
}

function readGifDimensions(bytes) {
	if (ascii(bytes, 0, 3) !== "GIF") return null;
	const width = readU16le(bytes, 6);
	const height = readU16le(bytes, 8);
	if (width < 1 || height < 1) return null;
	return { width, height };
}

function readWebpDimensions(bytes) {
	if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
	const kind = ascii(bytes, 12, 4);
	if (kind === "VP8X" && bytes.byteLength >= 30) {
		return { width: readU24le(bytes, 24) + 1, height: readU24le(bytes, 27) + 1 };
	}
	if (kind === "VP8 " && bytes.byteLength >= 30) {
		return { width: readU16le(bytes, 26) & 0x3fff, height: readU16le(bytes, 28) & 0x3fff };
	}
	if (kind === "VP8L" && bytes.byteLength >= 25) {
		const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	return null;
}

function exceedsLimit(dimensions, maxDimension) {
	return dimensions !== null && (dimensions.width > maxDimension || dimensions.height > maxDimension);
}

async function defaultProcess(bytes, mimeType, maxDimension) {
	return processImage(bytes, mimeType, {
		autoResizeImages: true,
		resizeOptions: { maxWidth: maxDimension, maxHeight: maxDimension },
	});
}

async function storedProcess(bytes, mimeType) {
	return processImage(bytes, mimeType, {
		autoResizeImages: true,
		resizeOptions: {
			maxWidth: STORED_IMAGE_MAX_DIMENSION,
			maxHeight: STORED_IMAGE_MAX_DIMENSION,
			maxBytes: STORED_IMAGE_MAX_BASE64,
		},
	});
}

/**
 * Shrink one tool-result image to what the model can actually see before it is stored.
 * Unlike the request-time limit, a failure keeps the original: this copy is the record.
 */
export async function compactStoredImage(block, options = {}) {
	if (block?.type !== "image" || typeof block.data !== "string" || block.data.length === 0) return block;
	if (isVideoMimeType(block.mimeType)) return block;
	const bytes = Buffer.from(block.data, "base64");
	const dimensions = readImageDimensions(bytes);
	if (dimensions && !exceedsLimit(dimensions, STORED_IMAGE_MAX_DIMENSION) && block.data.length < STORED_IMAGE_MAX_BASE64) {
		return block;
	}
	const processed = await (options.process ?? storedProcess)(bytes, block.mimeType);
	if (processed?.ok !== true || typeof processed.data !== "string" || processed.data.length === 0) return block;
	if (processed.data.length >= block.data.length) return block;
	const image = { type: "image", data: processed.data, mimeType: processed.mimeType ?? block.mimeType };
	const hints = Array.isArray(processed.hints) ? processed.hints.filter((hint) => typeof hint === "string" && hint.length > 0) : [];
	return hints.length === 0 ? image : [image, { type: "text", text: hints.join("\n") }];
}

/**
 * Downscale one ImageContent block so neither side exceeds Anthropic's
 * many-image cap. Video attachments stay untouched. If resize fails, replace
 * the block with a text note so one oversized image cannot 400 the request.
 */
export async function limitImageBlock(block, options = {}) {
	if (block?.type !== "image" || typeof block.data !== "string" || block.data.length === 0) return block;
	if (isVideoMimeType(block.mimeType)) return block;
	const maxDimension = options.maxDimension ?? MANY_IMAGE_MAX_DIMENSION;
	const cache = options.cache;
	if (cache?.has(block.data)) return cache.get(block.data);
	const bytes = Buffer.from(block.data, "base64");
	const dimensions = readImageDimensions(bytes);
	if (dimensions && !exceedsLimit(dimensions, maxDimension)) {
		cache?.set(block.data, block);
		return block;
	}
	const processed = await (options.process ?? defaultProcess)(bytes, block.mimeType, maxDimension);
	if (processed?.ok === true && typeof processed.data === "string" && processed.data.length > 0) {
		const image = { type: "image", data: processed.data, mimeType: processed.mimeType ?? block.mimeType };
		const hints = Array.isArray(processed.hints) ? processed.hints.filter((hint) => typeof hint === "string" && hint.length > 0) : [];
		const result = hints.length === 0 ? image : [image, { type: "text", text: hints.join("\n") }];
		cache?.set(block.data, result);
		return result;
	}
	const size = dimensions ? `${dimensions.width}×${dimensions.height}` : "unknown size";
	const result = {
		type: "text",
		text: `[Image omitted: ${size} exceeds the ${maxDimension}px many-image limit and could not be resized.]`,
	};
	cache?.set(block.data, result);
	return result;
}

function pushLimited(content, limited) {
	if (Array.isArray(limited)) content.push(...limited);
	else content.push(limited);
}

/** Request-time walk: user and toolResult image blocks, plus any nested content arrays. */
export async function limitInlineImages(messages, options = {}) {
	if (!Array.isArray(messages) || messages.length === 0) return messages;
	let changed = false;
	const next = [];
	for (const message of messages) {
		if (!Array.isArray(message?.content)) {
			next.push(message);
			continue;
		}
		const content = [];
		let messageChanged = false;
		for (const block of message.content) {
			const limited = await limitImageBlock(block, options);
			if (limited !== block) messageChanged = true;
			pushLimited(content, limited);
		}
		next.push(messageChanged ? { ...message, content } : message);
		changed ||= messageChanged;
	}
	return changed ? next : messages;
}

export function installImageLimit(pi) {
	const cache = new Map();
	for (const event of ["session_start", "session_shutdown"]) {
		pi.on(event, () => cache.clear());
	}
	pi.on("tool_result", async (event) => {
		if (!Array.isArray(event.content) || !event.content.some((block) => block?.type === "image")) return;
		const content = [];
		let changed = false;
		for (const block of event.content) {
			const compacted = await compactStoredImage(block);
			if (compacted !== block) changed = true;
			pushLimited(content, compacted);
		}
		if (changed) return { content };
	});
	pi.on("context", async (event) => {
		const messages = await limitInlineImages(event.messages, { cache });
		if (messages === event.messages) return;
		return { messages };
	});
}
