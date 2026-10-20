import assert from "node:assert/strict";
import test from "node:test";

import {
	MANY_IMAGE_MAX_DIMENSION,
	STORED_IMAGE_MAX_BASE64,
	USER_IMAGE_JPEG_QUALITY,
	compactStoredImage,
	compactUserImage,
	installImageLimit,
	limitImageBlock,
	limitInlineImages,
	readImageDimensions,
	pinnedImageBlock,
	IMAGE_PROJECTION_ENTRY,
} from "./src/host/image-limit.mjs";
import { loadPhoton } from "./src/host-sdk.mjs";

test("request image normalization remains byte-identical after restart even when codec availability changes", async () => {
	const journal = [];
	const pins = new Map();
	const block = image(pngHeader(4000, 3000));
	const before = structuredClone(block);
	const first = await pinnedImageBlock(block, pins, { process: async () => ({ ok: false }),
		savePin: async (record) => journal.push(structuredClone(record)) });
	assert.equal(first.type, "text");
	const resumedPins = new Map(journal.map((record) => [record.source, record]));
	const resumed = await pinnedImageBlock(block, resumedPins, { process: async () => {
		throw new Error("a pinned projection must not run the codec again");
	} });
	assert.deepEqual(resumed, first);
	assert.deepEqual(block, before, "the original image remains available in history");
	journal[0].sha256 = "corrupt";
	await assert.rejects(pinnedImageBlock(block, resumedPins), /corrupt/);
});

test("installed context hook replays image decisions from the selected journal branch", async () => {
	const entries = [];
	const ctx = { sessionManager: { getBranch: () => entries } };
	const handlers = {};
	const pi = {
		on: (event, handler) => { handlers[event] = handler; },
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	};
	const messages = [{ role: "user", content: [image(pngHeader(4000, 3000))] }];
	installImageLimit(pi, { process: async () => ({ ok: true, data: "c21hbGw=", mimeType: "image/jpeg" }) });
	const first = await handlers.context({ messages }, ctx);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].customType, IMAGE_PROJECTION_ENTRY);
	installImageLimit(pi, { process: async () => { throw new Error("must replay the journal"); } });
	assert.deepEqual(await handlers.context({ messages }, ctx), first);
	assert.equal(entries.length, 1, "resume does not append another decision");
	assert.equal(messages[0].content[0].mimeType, "image/png");
});

function pngHeader(width, height) {
	const bytes = Buffer.alloc(24);
	bytes[0] = 0x89;
	bytes.write("PNG\r\n\x1a\n", 1);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

function image(bytes, mimeType = "image/png") {
	return { type: "image", data: bytes.toString("base64"), mimeType };
}

test("readImageDimensions reads PNG IHDR", () => {
	assert.deepEqual(readImageDimensions(pngHeader(2001, 1200)), { width: 2001, height: 1200 });
	assert.deepEqual(readImageDimensions(pngHeader(1, 1)), { width: 1, height: 1 });
	assert.equal(readImageDimensions(Buffer.from("not-an-image")), null);
});

test("images already inside the many-image cap are left untouched", async () => {
	const small = image(pngHeader(2000, 1999));
	const process = async () => {
		throw new Error("must not resize an in-limit image");
	};
	assert.equal(await limitImageBlock(small, { process }), small);
});

test("oversized images are resized before the provider request", async () => {
	const large = image(pngHeader(3024, 1964));
	const process = async () => ({
		ok: true,
		data: "resized",
		mimeType: "image/jpeg",
		hints: ["[Image resized from 3024x1964 to 2000x1299.]"],
	});
	assert.deepEqual(await limitImageBlock(large, { process }), [
		{ type: "image", data: "resized", mimeType: "image/jpeg" },
		{ type: "text", text: "[Image resized from 3024x1964 to 2000x1299.]" },
	]);
});

test("unresizable oversized images become a text note instead of 400ing the request", async () => {
	const large = image(pngHeader(MANY_IMAGE_MAX_DIMENSION + 1, 100));
	const process = async () => ({ ok: false });
	assert.deepEqual(await limitImageBlock(large, { process }), {
		type: "text",
		text: "[Image omitted: 2001×100 exceeds the 2000px many-image limit and could not be resized.]",
	});
});

test("video and audio attachments are not treated as still images", async () => {
	const process = async () => {
		throw new Error("must not resize media");
	};
	for (const mimeType of ["video/mp4", "audio/mp3"]) {
		const clip = { type: "image", data: "aaaa", mimeType };
		assert.equal(await limitImageBlock(clip, { process }), clip);
		assert.equal(await compactStoredImage(clip, { process }), clip);
	}
});

test("limitInlineImages walks user and toolResult image blocks", async () => {
	const large = image(pngHeader(2500, 100));
	const small = image(pngHeader(10, 10));
	const process = async () => ({ ok: true, data: "ok", mimeType: "image/png", hints: [] });
	const messages = [
		{ role: "user", content: [{ type: "text", text: "see" }, large] },
		{ role: "assistant", content: [{ type: "text", text: "looking" }] },
		{ role: "toolResult", toolName: "read", content: [small, large] },
	];
	const limited = await limitInlineImages(messages, { process });
	assert.notEqual(limited, messages);
	assert.equal(limited[0].content[1].data, "ok");
	assert.equal(limited[2].content[0], small);
	assert.equal(limited[2].content[1].data, "ok");
});

test("context hook downscales only the request copy", async () => {
	const large = image(pngHeader(2500, 80));
	const handlers = {};
	installImageLimit({
		on(event, handler) {
			handlers[event] = handler;
		},
	});
	assert.equal(typeof handlers.context, "function");
	const messages = [{ role: "user", content: [large] }];
	const result = await handlers.context({
		type: "context",
		messages,
	});
	assert.ok(result?.messages);
	assert.equal(result.messages[0].content[0].type, "text");
	assert.match(result.messages[0].content[0].text, /2000px many-image limit/);
	assert.equal(messages[0].content[0], large);
	handlers.session_shutdown();
});

test("tool-result images are stored at the size the model sees, and kept when shrinking fails", async () => {
	const handlers = {};
	installImageLimit({ on(event, handler) { handlers[event] = handler; } });
	assert.equal(typeof handlers.tool_result, "function");
	const text = { type: "text", text: "screenshot" };
	assert.equal(await handlers.tool_result({ type: "tool_result", content: [text] }), undefined);

	const large = image(pngHeader(924, 2000));
	const shrunk = await compactStoredImage(large, {
		process: async () => ({ ok: true, data: "c21hbGw=", mimeType: "image/jpeg", hints: [] }),
	});
	assert.deepEqual(shrunk, { type: "image", data: "c21hbGw=", mimeType: "image/jpeg" });
	const failed = await compactStoredImage(large, { process: async () => ({ ok: false }) });
	assert.equal(failed, large);
	const small = image(pngHeader(800, 600));
	assert.equal(await compactStoredImage(small, { process: async () => { throw new Error("must not touch"); } }), small);
});

function photonPng(width, height, pixel) {
	const photon = loadPhoton();
	const raw = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const [r, g, b, a = 255] = pixel(x, y);
			raw.set([r, g, b, a], (y * width + x) * 4);
		}
	}
	const image = new photon.PhotonImage(raw, width, height);
	try {
		return Buffer.from(image.get_bytes());
	} finally {
		image.free();
	}
}

// Camera-like content: smooth light falloff plus sensor grain. Seeded so sizes are stable.
function photoPixel() {
	let seed = 7;
	const grain = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 24;
	return (x, y) => [120 + 80 * Math.sin(x / 90) + grain(), 100 + 60 * Math.cos(y / 70) + grain(), 90 + grain()]
		.map((value) => Math.max(0, Math.min(255, Math.round(value))));
}

test("a user-attached PNG photo is stored as JPEG 92 at the same resolution", async () => {
	const png = photonPng(1200, 900, photoPixel());
	const block = image(png);
	assert.ok(block.data.length > STORED_IMAGE_MAX_BASE64, "fixture must be big enough to matter");
	const compacted = await compactUserImage(block);
	assert.equal(compacted.mimeType, "image/jpeg");
	assert.ok(compacted.data.length * 2 <= block.data.length, `${compacted.data.length} vs ${block.data.length}`);
	const photon = loadPhoton();
	const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(compacted.data, "base64"));
	try {
		assert.deepEqual([decoded.get_width(), decoded.get_height()], [1200, 900]);
	} finally {
		decoded.free();
	}
	assert.equal(USER_IMAGE_JPEG_QUALITY, 92);
});

test("user images that JPEG would hurt or barely shrink stay as they were", async () => {
	const encode = async () => { throw new Error("must not encode"); };
	const small = image(pngHeader(800, 600));
	assert.equal(await compactUserImage(small, { encode }), small);
	const jpeg = { ...image(Buffer.alloc(STORED_IMAGE_MAX_BASE64)), mimeType: "image/jpeg" };
	assert.equal(await compactUserImage(jpeg, { encode }), jpeg);

	// One clear pixel is enough: JPEG has no alpha and would paint it black.
	const pixel = photoPixel();
	const clear = image(photonPng(1200, 900, (x, y) => [...pixel(x, y), x === 0 && y === 0 ? 0 : 255]));
	assert.equal(await compactUserImage(clear, { minBase64: 1 }), clear);

	// Flat UI: solid panels and thin rules. PNG already stores this well; JPEG would ring.
	const ui = image(photonPng(1200, 900, (x, y) => (y % 40 < 2 || x % 300 < 2 ? [30, 30, 30] : [245, 245, 245])));
	assert.equal(await compactUserImage(ui, { minBase64: 1 }), ui);

	const failing = image(photonPng(1200, 900, photoPixel()));
	assert.equal(await compactUserImage(failing, { encode: async () => { throw new Error("codec down"); } }), failing);
});

test("input hook swaps only the images it shrank and keeps the typed text", async () => {
	const handlers = {};
	installImageLimit({ on(event, handler) { handlers[event] = handler; } });
	assert.equal(await handlers.input({ type: "input", text: "hi" }), undefined);
	const photo = image(photonPng(1200, 900, photoPixel()));
	const small = image(pngHeader(10, 10));
	const result = await handlers.input({ type: "input", text: "이 사진 봐", images: [photo, small] });
	assert.equal(result.action, "transform");
	assert.equal(result.text, "이 사진 봐");
	assert.equal(result.images[0].mimeType, "image/jpeg");
	assert.equal(result.images[1], small);
});
