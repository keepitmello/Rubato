import assert from "node:assert/strict";
import test from "node:test";

import {
	MANY_IMAGE_MAX_DIMENSION,
	installImageLimit,
	limitImageBlock,
	limitInlineImages,
	readImageDimensions,
} from "./src/host/image-limit.mjs";

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

test("video attachments are not treated as still images", async () => {
	const clip = { type: "image", data: "aaaa", mimeType: "video/mp4" };
	const process = async () => {
		throw new Error("must not resize video");
	};
	assert.equal(await limitImageBlock(clip, { process }), clip);
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
