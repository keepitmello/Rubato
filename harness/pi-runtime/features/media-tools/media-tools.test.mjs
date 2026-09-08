import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stagePiRuntime } from "../../stage-runtime.mjs";
import { toolExecutionFeature } from "../tool-execution/index.mjs";
import { feature, files } from "./patches.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function textOf(result) {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
	});
}

async function waitUntil(predicate, message, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(20);
	}
	assert.fail(message);
}

async function createLoopbackServer(t) {
	const sockets = new Set();
	const imageRequests = [];
	let slowStarted = false;
	let slowClosed = false;
	let imageAbortStarted = false;
	let imageAbortClosed = false;
	let beforeImageResponse;
	const server = createServer(async (request, response) => {
		if (request.method === "POST" && request.url === "/v1/images/generations") {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			imageRequests.push({ payload, headers: { ...request.headers } });
			if (payload.prompt.includes("abort image fixture")) {
				imageAbortStarted = true;
				response.on("close", () => {
					imageAbortClosed = true;
				});
				return;
			}
			await beforeImageResponse?.(payload);
			if (payload.prompt.includes("provider error fixture")) {
				const body = JSON.stringify({ error: { message: "fixture rejected image prompt", type: "invalid_request_error" } });
				response.writeHead(400, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
				response.end(body);
				return;
			}
			const body = JSON.stringify({
				created: 1,
				data: Array.from({ length: payload.n ?? 1 }, (_, index) => ({
					b64_json: PNG_DATA,
					revised_prompt: `fixture revised prompt ${index + 1}`,
				})),
				usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 },
			});
			response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
			response.end(body);
			return;
		}
		if (request.url === "/redirect") {
			response.writeHead(302, { Location: "/article" });
			response.end();
			return;
		}
		if (request.url === "/article") {
			const body = `<!doctype html><html><head><title>Fallback title</title></head><body>
				<nav>navigation must be removed</nav><h1>Rubato article</h1>
				<main class="entry-content"><p>Hello <strong>42</strong>. This article body is deliberately long enough for explicit extraction.</p></main>
			</body></html>`;
			response.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Length": Buffer.byteLength(body),
			});
			response.end(body);
			return;
		}
		if (request.url === "/too-large") {
			response.writeHead(200, {
				"Content-Type": "text/plain",
				"Content-Length": String(5 * 1024 * 1024 + 1),
			});
			response.end("bounded rejection");
			return;
		}
		if (request.url === "/slow") {
			slowStarted = true;
			response.on("close", () => {
				slowClosed = true;
			});
			response.writeHead(200, { "Content-Type": "text/plain" });
			response.write("partial response");
			return;
		}
		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("not found");
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		if (server.listening) {
			const closed = once(server, "close");
			server.close();
			server.closeAllConnections?.();
			await closed;
		}
		await waitUntil(() => sockets.size === 0, `loopback server retained ${sockets.size} socket(s)`);
	});
	const address = server.address();
	assert.notEqual(address, null);
	assert.equal(typeof address, "object");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		get slowStarted() {
			return slowStarted;
		},
		get slowClosed() {
			return slowClosed;
		},
		imageRequests,
		get imageAbortStarted() {
			return imageAbortStarted;
		},
		get imageAbortClosed() {
			return imageAbortClosed;
		},
		setBeforeImageResponse(hook) {
			beforeImageResponse = hook;
		},
	};
}

test("media-tools source closure is runtime-owned and carries webfetch, look_at, and generate_image", async () => {
	assert.equal(files.length, 38);
	assert.equal(files.every((entry) => entry.target === "runtime"), true);
	for (const sourceFile of sourceFiles(fileURLToPath(new URL("./src", import.meta.url)))) {
		const source = readFileSync(sourceFile, "utf8");
		assert.doesNotMatch(source, /["']@code-yeongyu\/senpi(?:["'/])/, `Senpi runtime import in ${sourceFile}`);
		assert.doesNotMatch(source, /\/Users\/wy|rubato-senpi-source/, `checkout path in ${sourceFile}`);
	}
	const module = await import("./src/index.mjs");
	assert.equal(typeof module.default, "function");
	assert.equal(typeof module.webfetchExtension, "function");
	assert.equal(typeof module.lookAtExtension, "function");
	assert.equal(typeof module.imageGenExtension, "function");
});

test("imagegen auth keeps stored, pinned gateway, sorted gateway, environment, and sentinel precedence", async () => {
	const { resolveImageGenAuth } = await import("./src/imagegen/auth.js");
	const gateway = (provider) => ({
		provider,
		id: `${provider}-model`,
		baseUrl: `https://${provider}.example.test`,
		api: "openai-responses",
	});
	function registry({ models = [], credentials = {}, storedOpenAI } = {}) {
		return {
			getProviderAuthStatus: (provider) => ({
				configured: provider === "openai" && storedOpenAI !== undefined,
				...(provider === "openai" && storedOpenAI !== undefined ? { source: "stored" } : {}),
			}),
			getProviderAuth: async (provider) =>
				provider === "openai" && storedOpenAI !== undefined ? { auth: { apiKey: storedOpenAI } } : undefined,
			getAll: () => models,
			getApiKeyAndHeaders: async (model) =>
				credentials[model.provider]
					? { ok: true, apiKey: credentials[model.provider], headers: { "x-fixture-provider": model.provider } }
					: { ok: false, error: "not configured" },
		};
	}

	const models = [gateway("zeta"), gateway("my-openai-gateway"), gateway("alpha")];
	const stored = await resolveImageGenAuth({
		modelRegistry: registry({ models, credentials: { zeta: "zeta-key" }, storedOpenAI: "stored-key" }),
		env: { PI_IMAGE_GEN_PROVIDER: "zeta", OPENAI_API_KEY: "env-key" },
	});
	assert.deepEqual(stored, {
		kind: "native-openai",
		apiKey: "stored-key",
		baseUrl: "https://api.openai.com/v1",
		provenance: "store",
		providerId: "openai",
	});

	const pinned = await resolveImageGenAuth({
		modelRegistry: registry({ models, credentials: { zeta: "zeta-key", "my-openai-gateway": "openai-gateway-key" } }),
		env: { PI_IMAGE_GEN_PROVIDER: "zeta", OPENAI_API_KEY: "env-key" },
	});
	assert.equal(pinned.providerId, "zeta");
	assert.equal(pinned.provenance, "provider-config");
	assert.deepEqual(pinned.headers, { "x-fixture-provider": "zeta" });

	const sorted = await resolveImageGenAuth({
		modelRegistry: registry({
			models,
			credentials: { alpha: "alpha-key", zeta: "zeta-key", "my-openai-gateway": "openai-gateway-key" },
		}),
		env: {},
	});
	assert.equal(sorted.providerId, "my-openai-gateway", "OpenAI-named gateways retain first preference");

	const sentinelFallsThrough = await resolveImageGenAuth({
		modelRegistry: registry({
			models: [gateway("alpha")],
			credentials: { alpha: "alpha-key" },
			storedOpenAI: "SK-SENTINEL-DO-NOT-LOG-fixture",
		}),
		env: { OPENAI_API_KEY: "SK-SENTINEL-DO-NOT-LOG-env" },
	});
	assert.equal(sentinelFallsThrough.providerId, "alpha");

	const fromEnv = await resolveImageGenAuth({
		modelRegistry: registry(),
		env: { OPENAI_API_KEY: "env-key" },
	});
	assert.deepEqual(fromEnv, {
		kind: "native-openai",
		apiKey: "env-key",
		baseUrl: "https://api.openai.com/v1",
		provenance: "env",
	});
	const missing = await resolveImageGenAuth({ modelRegistry: registry(), env: {} });
	assert.equal(missing.kind, "none");
	assert.match(missing.reason, /Image generation is not configured/);
});

test("imagegen output paths stay deterministic, PNG-only, and tool-call-id safe", async () => {
	const { displayPath, resolveTargets, sanitizeImageStem } = await import("./src/imagegen/paths.js");
	const cwd = resolve(tmpdir(), "rubato-image-path-fixture");
	assert.equal(sanitizeImageStem("../unsafe/id"), "___unsafe_id");
	assert.deepEqual(resolveTargets(cwd, "../unsafe/id", 2), {
		ok: true,
		paths: [
			join(cwd, "generated-images/___unsafe_id-01.png"),
			join(cwd, "generated-images/___unsafe_id-02.png"),
		],
	});
	assert.deepEqual(resolveTargets(cwd, "call", 1, "artifacts/result"), {
		ok: true,
		paths: [join(cwd, "artifacts/result.png")],
	});
	assert.match(resolveTargets(cwd, "call", 1, "artifacts/result.jpg").error, /must end in \.png/);
	assert.equal(displayPath(cwd, join(cwd, "artifacts/result.png")), "artifacts/result.png");
});

test("staged stock SDK executes webfetch, look_at, and client generate_image against local fixtures", async (t) => {
	const previousWebfetchEnv = process.env.PI_WEBFETCH;
	delete process.env.PI_WEBFETCH;
	t.after(() => {
		if (previousWebfetchEnv === undefined) delete process.env.PI_WEBFETCH;
		else process.env.PI_WEBFETCH = previousWebfetchEnv;
	});
	const loopback = await createLoopbackServer(t);
	const scratch = mkdtempSync(join(tmpdir(), "rubato-media-tools-"));
	let session;
	t.after(async () => {
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined);
			session.dispose();
		}
		rmSync(scratch, { recursive: true, force: true });
	});

	const outputRoot = join(scratch, "engine");
	const staged = await stagePiRuntime({
		sourceRoot: runtimeRoot,
		outputRoot,
		features: [toolExecutionFeature, feature],
	});
	const mediaFiles = staged.receipt.addedFiles.filter((entry) => entry.feature === "media-tools");
	assert.equal(mediaFiles.length, files.length);
	assert.equal(mediaFiles.every((entry) => entry.path.startsWith("rubato-features/media-tools/")), true);

	const stagedEntry = join(outputRoot, "rubato-features/media-tools/src/index.mjs");
	for (const [packageName, version] of [
		["undici", "8.10.0"],
		["jsdom", "30.0.1"],
		["@mozilla/readability", "0.6.0"],
		["turndown", "7.2.4"],
		["openai", "6.26.0"],
	]) {
		const manifest = findPackageJSON(packageName, pathToFileURL(stagedEntry));
		assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, version);
	}

	const sdk = await import(pathToFileURL(staged.runtime.sdkEntry).href);
	const media = await import(pathToFileURL(stagedEntry).href);
	process.env.PI_WEBFETCH = "off";
	assert.equal(media.isWebfetchEnabled(), false);
	delete process.env.PI_WEBFETCH;
	assert.equal(media.isWebfetchEnabled(), true);
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(cwd, "sample.png"), Buffer.from(PNG_DATA, "base64"));
	const baseModel = {
		provider: "media-fixture",
		api: "openai-completions",
		baseUrl: loopback.baseUrl,
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 4_096,
	};
	const textModel = { ...baseModel, id: "text-fixture", name: "Text fixture", input: ["text"] };
	const visionModel = {
		...baseModel,
		id: "vision-fixture",
		name: "Vision fixture",
		input: ["text", "image"],
	};
	let extensionApi;
	let lookAtAbortStarted = false;
	const lookAtRequests = [];
	const settingsManager = sdk.SettingsManager.inMemory({
		images: { autoResize: false, blockImages: false },
		lookAt: { enabled: true, models: ["media-fixture/vision-fixture:low"] },
	});
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{
				name: "rubato-media-tools",
				factory: (pi) => {
					extensionApi = pi;
					pi.registerProvider("media-fixture", {
						name: "Media fixture",
						baseUrl: baseModel.baseUrl,
						apiKey: "media-fixture-not-a-real-key",
						api: baseModel.api,
						headers: { "x-image-fixture": "present" },
						models: [textModel, visionModel],
					});
					media.default(pi, {
						createSettingsManager: () => settingsManager,
						complete: async (model, context, options) => {
							lookAtRequests.push({ model, context, options });
							const prompt = context.messages[0].content.find((part) => part.type === "text")?.text ?? "";
							if (prompt.includes("provider error fixture")) {
								return {
									role: "assistant",
									content: [],
									stopReason: "error",
									errorMessage: "fixture vision failure",
								};
							}
							if (prompt.includes("empty result fixture")) {
								return { role: "assistant", content: [], stopReason: "stop" };
							}
							if (prompt.includes("abort this analysis")) {
								lookAtAbortStarted = true;
								await new Promise((resolveWait, reject) => {
									const timer = setTimeout(resolveWait, 5_000);
									options.signal.addEventListener(
										"abort",
										() => {
											clearTimeout(timer);
											reject(options.signal.reason ?? new Error("aborted"));
										},
										{ once: true },
									);
								});
							}
							return {
								role: "assistant",
								content: [{ type: "text", text: "fixture saw one PNG" }],
								stopReason: "stop",
							};
						},
					});
				},
			},
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	({ session } = await sdk.createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: sdk.SessionManager.inMemory(cwd),
		model: textModel,
	}));
	const extensionErrors = [];
	await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
	assert.deepEqual(extensionErrors, []);
	assert.equal(typeof session.getToolDefinition("webfetch")?.execute, "function");
	assert.equal(session.getActiveToolNames().includes("webfetch"), true);
	assert.equal(typeof session.getToolDefinition("look_at")?.execute, "function");
	assert.equal(session.getActiveToolNames().includes("look_at"), true);
	assert.equal(typeof session.getToolDefinition("generate_image")?.execute, "function");
	assert.equal(session.getActiveToolNames().includes("generate_image"), true);
	const imageSkill = resourceLoader.getSkills().skills.find((skill) => skill.name === "gpt-image-gen");
	assert.notEqual(imageSkill, undefined);
	assert.equal(
		realpathSync(imageSkill.filePath),
		realpathSync(join(outputRoot, "rubato-features/media-tools/src/imagegen/skill/SKILL.md")),
	);
	const imagePrompt = await session.extensionRunner.emitBeforeAgentStart("fixture", [], "BASE PROMPT", {});
	assert.match(imagePrompt.systemPrompt, /## Image Generation/);

	const updates = [];
	const fetched = await extensionApi.executeTool(
		"webfetch",
		{ url: `${loopback.baseUrl}/redirect`, format: "markdown", timeout: 2 },
		{ onUpdate: (update) => updates.push(update.details?.phase) },
	);
	assert.equal(fetched.details.status, 200);
	assert.equal(fetched.details.finalUrl, `${loopback.baseUrl}/article`);
	assert.equal(fetched.details.converted, true);
	assert.match(textOf(fetched), /^# Rubato article/m);
	assert.match(textOf(fetched), /Hello \*\*42\*\*/);
	assert.doesNotMatch(textOf(fetched), /navigation must be removed/);
	assert.deepEqual(updates, ["fetching", "downloading", "converting"]);

	const invalid = await extensionApi.executeTool("webfetch", { url: "file:///etc/hosts", format: "text" });
	assert.equal(invalid.details.isError, true);
	assert.match(textOf(invalid), /URL must start with http:\/\/ or https:\/\//);

	const oversized = await extensionApi.executeTool("webfetch", {
		url: `${loopback.baseUrl}/too-large`,
		format: "text",
		timeout: 2,
	});
	assert.equal(oversized.details.isError, true);
	assert.match(textOf(oversized), /Response too large/);

	const controller = new AbortController();
	const pending = extensionApi.executeTool(
		"webfetch",
		{ url: `${loopback.baseUrl}/slow`, format: "text", timeout: 10 },
		{ signal: controller.signal },
	);
	await waitUntil(() => loopback.slowStarted, "webfetch abort probe never reached loopback server");
	controller.abort(new Error("media-tools abort probe"));
	const aborted = await pending;
	assert.equal(aborted.details.isError, true);
	assert.match(textOf(aborted), /Request aborted/);
	await waitUntil(() => loopback.slowClosed, "aborted webfetch kept its response socket open");

	const looked = await extensionApi.executeTool("look_at", {
		file_path: "sample.png",
		goal: "describe the local fixture",
	});
	assert.equal(textOf(looked), "fixture saw one PNG");
	assert.deepEqual(looked.details, {
		model: "media-fixture/vision-fixture",
		sources: ["sample.png"],
		mimeTypes: ["image/png"],
	});
	const lookAtRequest = lookAtRequests.at(-1);
	assert.equal(lookAtRequest.model.id, "vision-fixture");
	assert.equal(lookAtRequest.options.reasoning, "low");
	assert.equal(lookAtRequest.options.maxTokens, 4_096);
	assert.equal(lookAtRequest.context.messages[0].content[0].type, "image");
	assert.equal(lookAtRequest.context.messages[0].content[0].mimeType, "image/png");
	assert.equal(lookAtRequest.context.messages[0].content[0].data, PNG_DATA);

	await session.setModel(visionModel);
	assert.equal(session.getActiveToolNames().includes("look_at"), false);
	await session.setModel(textModel);
	assert.equal(session.getActiveToolNames().includes("look_at"), true);

	const rejectedRemote = await extensionApi.executeTool("look_at", {
		file_path: "https://example.invalid/image.png",
		goal: "must remain local",
	});
	assert.equal(rejectedRemote.details.isError, true);
	assert.match(textOf(rejectedRemote), /Remote URLs are not supported/);

	const providerError = await extensionApi.executeTool("look_at", {
		image_data: PNG_DATA,
		goal: "provider error fixture",
	});
	assert.equal(providerError.details.isError, true);
	assert.match(textOf(providerError), /fixture vision failure/);

	const emptyResult = await extensionApi.executeTool("look_at", {
		image_data: PNG_DATA,
		goal: "empty result fixture",
	});
	assert.equal(emptyResult.details.isError, true);
	assert.match(textOf(emptyResult), /Vision model returned no analysis text/);

	const lookAtAbort = new AbortController();
	const pendingLookAt = extensionApi.executeTool(
		"look_at",
		{ image_data: PNG_DATA, goal: "abort this analysis" },
		{ signal: lookAtAbort.signal },
	);
	await waitUntil(() => lookAtAbortStarted, "look_at abort probe did not enter the injected model runner");
	lookAtAbort.abort(new Error("media look_at abort probe"));
	const abortedLookAt = await pendingLookAt;
	assert.equal(abortedLookAt.details.isError, true);
	assert.match(textOf(abortedLookAt), /look_at analysis was aborted/);
	assert.equal(lookAtRequests.at(-1).options.signal.aborted, true);

	const generated = await extensionApi.executeTool(
		"generate_image",
		{
			prompt: "draw the local image fixture",
			size: "1024x1536",
			quality: "high",
			n: 2,
			output_path: "outputs/art.png",
		},
		{ toolCallId: "image-success" },
	);
	assert.deepEqual(generated.details, {
		paths: ["outputs/art-01.png", "outputs/art-02.png"],
		model: "gpt-image-2",
		source: "provider-config:media-fixture",
		size: "1024x1536",
		quality: "high",
		requested: 2,
		generated: 2,
		revisedPrompts: ["fixture revised prompt 1", "fixture revised prompt 2"],
	});
	assert.equal(generated.content.filter((part) => part.type === "image").length, 2);
	assert.equal(generated.usage.input, 7);
	assert.equal(generated.usage.output, 11);
	for (const path of generated.details.paths) {
		assert.deepEqual(readFileSync(join(cwd, path)), Buffer.from(PNG_DATA, "base64"));
	}
	const successfulImageRequest = loopback.imageRequests.at(-1);
	assert.deepEqual(successfulImageRequest.payload, {
		model: "gpt-image-2",
		prompt: "draw the local image fixture",
		size: "1024x1536",
		quality: "high",
		n: 2,
		output_format: "png",
		stream: false,
	});
	assert.equal(successfulImageRequest.headers.authorization, "Bearer media-fixture-not-a-real-key");
	assert.equal(successfulImageRequest.headers["x-image-fixture"], "present");

	writeFileSync(join(cwd, "already-there.png"), "owned by fixture");
	const requestsBeforePreflight = loopback.imageRequests.length;
	const preflight = await extensionApi.executeTool("generate_image", {
		prompt: "must not make a provider request",
		output_path: "already-there.png",
	});
	assert.equal(preflight.details.reason, "invalid_params");
	assert.match(textOf(preflight), /already exists/);
	assert.equal(loopback.imageRequests.length, requestsBeforePreflight);
	assert.equal(readFileSync(join(cwd, "already-there.png"), "utf8"), "owned by fixture");

	const blankPrompt = await extensionApi.executeTool("generate_image", { prompt: "   " });
	assert.equal(blankPrompt.details.reason, "invalid_params");
	assert.match(textOf(blankPrompt), /non-whitespace text/);

	const providerFailure = await extensionApi.executeTool("generate_image", {
		prompt: "provider error fixture",
		output_path: "provider-error.png",
	});
	assert.equal(providerFailure.details.reason, "provider_error");
	assert.match(textOf(providerFailure), /fixture rejected image prompt/);
	assert.equal(existsSync(join(cwd, "provider-error.png")), false);

	const imageAbort = new AbortController();
	const pendingImage = extensionApi.executeTool(
		"generate_image",
		{ prompt: "abort image fixture", output_path: "aborted.png" },
		{ signal: imageAbort.signal },
	);
	await waitUntil(() => loopback.imageAbortStarted, "generate_image abort probe never reached the provider fixture");
	imageAbort.abort(new Error("generate_image local abort probe"));
	const abortedImage = await pendingImage;
	assert.equal(abortedImage.details.reason, "provider_error");
	assert.match(textOf(abortedImage), /abort/i);
	assert.equal(existsSync(join(cwd, "aborted.png")), false);
	await waitUntil(() => loopback.imageAbortClosed, "aborted generate_image request retained its provider socket");

	const rollbackSecond = join(cwd, "rollback-02.png");
	loopback.setBeforeImageResponse((payload) => {
		if (payload.prompt === "partial write rollback fixture") writeFileSync(rollbackSecond, "racing owner");
	});
	const rolledBack = await extensionApi.executeTool("generate_image", {
		prompt: "partial write rollback fixture",
		n: 2,
		output_path: "rollback.png",
	});
	loopback.setBeforeImageResponse(undefined);
	assert.equal(rolledBack.details.reason, "write_failed");
	assert.equal(existsSync(join(cwd, "rollback-01.png")), false);
	assert.equal(readFileSync(rollbackSecond, "utf8"), "racing owner");

	const imageState = await import(pathToFileURL(join(dirname(stagedEntry), "imagegen/state.js")).href);
	const requestsBeforeBypass = loopback.imageRequests.length;
	imageState.setNativeBypass(true);
	try {
		const bypassed = await extensionApi.executeTool("generate_image", { prompt: "native bypass fixture" });
		assert.equal(bypassed.details.reason, "provider_native_bypass");
		assert.match(textOf(bypassed), /native image_generation tool/);
		assert.equal(loopback.imageRequests.length, requestsBeforeBypass);
	}
	finally {
		imageState.setNativeBypass(false);
	}

	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	session = undefined;
});
