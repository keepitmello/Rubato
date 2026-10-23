import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { feature as parityGapsFeature } from "../parity-gaps/feature.mjs";
import { toolExecutionFeature } from "../tool-execution/index.mjs";
import { ANTIGRAVITY_API } from "../../../rubato-pi/src/antigravity-id.mjs";
import { feature, patches } from "./patches.mjs";
import {
	AUDIO_MIME_TYPE,
	MAX_REQUEST_VIDEOS,
	MEDIA_BYTE_LIMIT,
	MEDIA_SHORT_SIDE,
	VIDEO_MIME_TYPE,
	VIDEO_OMITTED_TEXT,
	installVideoLimit,
	limitRequestVideos,
	mediaKind,
	readMediaFile,
	watchesMedia,
} from "./src/read-media/index.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packages = (root) => resolvePiRuntime({ root }).packages;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const gemini = (api = "google-vertex", id = "gemini-3.8-flash") => ({
	provider: api, api, id, name: id, input: ["text", "image"], reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 65_536,
});
const claude = { ...gemini("anthropic-messages", "claude-opus-5-5"), provider: "anthropic" };

function ffprobe(path) {
	return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" }));
}

function fixtures(t) {
	const dir = mkdtempSync(join(tmpdir(), "read-media-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const video = join(dir, "clip.MOV");
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=2560x1440:rate=30:duration=4",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=4",
		"-ac", "2", "-shortest", "-c:v", "libx264", "-c:a", "aac", video,
	]);
	const audio = join(dir, "voice.wav");
	execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-ac", "2", audio]);
	return { dir, video, audio };
}

function decode(block, dir, name) {
	const path = join(dir, name);
	writeFileSync(path, Buffer.from(block.data, "base64"));
	return ffprobe(path);
}

test("media files are recognised by extension, other files fall through", () => {
	assert.equal(mediaKind("/a/b/Screen Recording.MOV"), "video");
	assert.equal(mediaKind("x.webm"), "video");
	assert.equal(mediaKind("x.m4a"), "audio");
	assert.equal(mediaKind("x.png"), undefined);
	assert.equal(mediaKind("x.ts"), undefined);
});

test("only Gemini on the google-shared encoders watches media", () => {
	assert.equal(watchesMedia(gemini("google-vertex", "gemini-4-argon")), true);
	assert.equal(watchesMedia(gemini("google-generative-ai")), true);
	assert.equal(watchesMedia(gemini(ANTIGRAVITY_API)), true);
	assert.equal(watchesMedia(gemini(ANTIGRAVITY_API, "claude-sonnet-5-5")), false);
	assert.equal(watchesMedia(gemini("cursor-agent", "gemini-3.8-flash")), false);
	assert.equal(watchesMedia(claude), false);
	assert.equal(watchesMedia(undefined), false);
});

test("video is re-encoded to 1 fps, capped short side and mono audio", async (t) => {
	const { dir, video } = fixtures(t);
	const { content } = await readMediaFile(video, gemini());
	assert.equal(content.length, 2);
	assert.match(content[0].text, /^Read video file \[video\/mp4\] clip\.MOV: 0:00–0:04 of 0:04/);
	assert.equal(content[1].type, "image");
	assert.equal(content[1].mimeType, VIDEO_MIME_TYPE);
	const probe = decode(content[1], dir, "out.mp4");
	const v = probe.streams.find((s) => s.codec_type === "video");
	const a = probe.streams.find((s) => s.codec_type === "audio");
	assert.equal(v.r_frame_rate, "1/1");
	assert.equal(Math.min(v.width, v.height), MEDIA_SHORT_SIDE);
	assert.equal(v.width / v.height, 16 / 9);
	assert.equal(a.channels, 1);
});

test("offset and limit are seconds and the clip says where it starts", async (t) => {
	const { dir, video } = fixtures(t);
	const { content } = await readMediaFile(video, gemini(), { offset: 1, limit: 2 });
	assert.match(content[0].text, /0:01–0:03 of 0:04/);
	assert.match(content[0].text, /start at 0:00, which is 0:01 in the file/);
	assert.match(content[0].text, /Use offset=3 to continue/);
	const duration = Number(decode(content[1], dir, "cut.mp4").format.duration);
	assert.ok(duration > 1.5 && duration < 2.6, `clip lasts ${duration}s`);
	await assert.rejects(readMediaFile(video, gemini(), { offset: 10 }), /beyond the end/);
});

test("audio is re-encoded to mono mp3", async (t) => {
	const { dir, audio } = fixtures(t);
	const { content } = await readMediaFile(audio, gemini());
	assert.equal(content[1].mimeType, AUDIO_MIME_TYPE);
	const probe = decode(content[1], dir, "out.mp3");
	assert.equal(probe.streams[0].codec_name, "mp3");
	assert.equal(probe.streams[0].channels, 1);
});

test("models without media input get a note instead of bytes", async (t) => {
	const { video } = fixtures(t);
	const { content } = await readMediaFile(video, claude);
	assert.equal(content.length, 1);
	assert.match(content[0].text, /clip\.MOV is video\. anthropic\/claude-opus-5-5 cannot take video input/);
});

test("clips over the byte limit return a shorter range to read", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "read-media-big-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const exec = async (command, args) => {
		if (command === "ffprobe") return "600.0\n";
		writeFileSync(args.at(-1), Buffer.alloc(MEDIA_BYTE_LIMIT * 2));
		return "";
	};
	const { content } = await readMediaFile(join(dir, "long.mp4"), gemini(), { exec });
	assert.equal(content.length, 1);
	assert.match(content[0].text, /over the 12\.0MB limit/);
	assert.match(content[0].text, /offset=0 limit=270/);
});

test("missing ffmpeg is reported, not thrown", async () => {
	const exec = async () => {
		throw Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" });
	};
	const { content } = await readMediaFile("/x/a.mp4", gemini(), { exec });
	assert.match(content[0].text, /needs ffmpeg/);
});

const videoRead = (n) => ({
	role: "toolResult",
	toolCallId: `read-${n}`,
	content: [
		{ type: "text", text: `Read video file [video/mp4] clip-${n}.mp4: 0:00–0:10 of 0:10` },
		{ type: "image", data: Buffer.from(`clip-${n}`).toString("base64"), mimeType: VIDEO_MIME_TYPE },
	],
});
const videosIn = (messages) => messages.flatMap((message) => message.content)
	.filter((block) => block.type === "image" && block.mimeType === VIDEO_MIME_TYPE)
	.map((block) => Buffer.from(block.data, "base64").toString());
const transcript = (count) => Array.from({ length: count }, (_, i) => [
	{ role: "user", content: [{ type: "text", text: `turn ${i + 1}` }] },
	videoRead(i + 1),
]).flat();

test("up to the video cap the request is sent unchanged", () => {
	const messages = transcript(MAX_REQUEST_VIDEOS);
	assert.equal(limitRequestVideos(messages), messages);
});

test("the video past the cap drops every older video and only the newest stays", () => {
	const messages = transcript(MAX_REQUEST_VIDEOS + 1);
	const limited = limitRequestVideos(messages);
	assert.deepEqual(videosIn(limited), [`clip-${MAX_REQUEST_VIDEOS + 1}`]);
	const first = limited[1];
	assert.equal(first.content[0].text, messages[1].content[0].text, "the read note naming the file stays");
	assert.deepEqual(first.content[1], { type: "text", text: VIDEO_OMITTED_TEXT });
	assert.equal(videosIn(messages).length, MAX_REQUEST_VIDEOS + 1, "the session history keeps every clip");
});

test("dropped videos stay dropped, so later requests keep the same prefix until the cap is reached again", () => {
	const atDrop = limitRequestVideos(transcript(MAX_REQUEST_VIDEOS + 1));
	for (let count = MAX_REQUEST_VIDEOS + 1; count <= 2 * MAX_REQUEST_VIDEOS; count += 1) {
		const limited = limitRequestVideos(transcript(count));
		assert.deepEqual(limited.slice(0, atDrop.length), atDrop, `request with ${count} videos`);
		assert.equal(videosIn(limited).length, count - MAX_REQUEST_VIDEOS);
	}
	const again = limitRequestVideos(transcript(2 * MAX_REQUEST_VIDEOS + 1));
	assert.deepEqual(videosIn(again), [`clip-${2 * MAX_REQUEST_VIDEOS + 1}`]);
});

test("videos in one message count one by one, and audio and images are not videos", () => {
	const many = { role: "user", content: Array.from({ length: MAX_REQUEST_VIDEOS + 2 }, (_, i) =>
		({ type: "image", data: Buffer.from(`clip-${i + 1}`).toString("base64"), mimeType: VIDEO_MIME_TYPE })) };
	const others = { role: "user", content: [
		{ type: "image", data: "YXVkaW8=", mimeType: AUDIO_MIME_TYPE },
		{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
	] };
	const limited = limitRequestVideos([many, others]);
	assert.deepEqual(videosIn(limited), [`clip-${MAX_REQUEST_VIDEOS + 1}`, `clip-${MAX_REQUEST_VIDEOS + 2}`]);
	assert.equal(limited[1], others);
});

test("the installed context hook returns the limited request only when it changes", async () => {
	const handlers = {};
	installVideoLimit({ on(event, handler) { handlers[event] = handler; } });
	assert.equal(await handlers.context({ messages: transcript(MAX_REQUEST_VIDEOS) }), undefined);
	const result = await handlers.context({ messages: transcript(MAX_REQUEST_VIDEOS + 1) });
	assert.deepEqual(videosIn(result.messages), [`clip-${MAX_REQUEST_VIDEOS + 1}`]);
});

test("stock targets match the media patch preimages", () => {
	const byId = Object.fromEntries(patches.map((patch) => [patch.id, patch]));
	const piAi = packages(runtimeRoot)["@earendil-works/pi-ai"].dir;
	const agent = packages(runtimeRoot)["@earendil-works/pi-coding-agent"].dir;
	for (const id of ["google-shared-media", "read-media", "tool-execution-media"]) {
		const patch = byId[id];
		const root = patch.packageName === "@earendil-works/pi-ai" ? piAi : agent;
		assert.equal(sha256(readFileSync(join(root, patch.path))), patch.preimageSha256, id);
	}
});

test("staged read sends video to Gemini as a high-resolution user turn after the function responses", async (t) => {
	const { dir, video } = fixtures(t);
	const scratch = mkdtempSync(join(tmpdir(), "read-media-stage-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const outputRoot = join(scratch, "engine");
	await stagePiRuntime({ sourceRoot: runtimeRoot, outputRoot, features: [toolExecutionFeature, parityGapsFeature, feature] });
	const staged = packages(outputRoot);
	const { createReadToolDefinition } = await import(pathToFileURL(join(staged["@earendil-works/pi-coding-agent"].dir, "dist/core/tools/read.js")).href);
	const { convertMessages } = await import(pathToFileURL(join(staged["@earendil-works/pi-ai"].dir, "dist/api/google-shared.js")).href);

	const read = createReadToolDefinition(dir);
	assert.match(read.description, /Video and audio files/);
	const model = gemini("google-vertex", "gemini-4-argon");
	const watched = await read.execute("call-1", { path: "clip.MOV" }, undefined, undefined, { cwd: dir, model });
	assert.equal(watched.content[1].mimeType, VIDEO_MIME_TYPE);
	const refused = await read.execute("call-x", { path: "clip.MOV" }, undefined, undefined, { cwd: dir, model: claude });
	assert.equal(refused.content.length, 1);

	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
	const context = {
		messages: [
			{ role: "user", content: "watch it", timestamp: 1 },
			{
				role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 2,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				content: [
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "clip.MOV" } },
					{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "shot.png" } },
				],
			},
			{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: watched.content, isError: false, timestamp: 3 },
			{ role: "toolResult", toolCallId: "call-2", toolName: "read", isError: false, timestamp: 4,
				content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: png, mimeType: "image/png" }] },
		],
	};
	const contents = convertMessages(model, context);
	const at = contents.findIndex((content) => content.parts.some((part) => part.functionResponse));
	assert.equal(contents.filter((content) => content.parts.some((part) => part.functionResponse)).length, 1,
		"both function responses share one user turn");
	const [first, second] = contents[at].parts;
	assert.equal(first.functionResponse.name, "read");
	assert.equal(first.functionResponse.parts, undefined, "video is not nested in the function response");
	assert.equal(second.functionResponse.parts[0].inlineData.mimeType, "image/png", "images still nest");
	// Vertex rejects video placed after a functionResponse in the same turn.
	assert.equal(contents[at].parts.length, 2);
	const media = contents[at + 1];
	assert.equal(media.role, "user");
	assert.equal(media.parts[0].text, "Tool result media:");
	assert.equal(media.parts[1].inlineData.mimeType, VIDEO_MIME_TYPE);
	assert.deepEqual(media.parts[1].mediaResolution, { level: "MEDIA_RESOLUTION_HIGH" });
	assert.equal(contents.length, at + 2, "nothing follows the media turn");
});
