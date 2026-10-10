import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stagePiRuntime } from "../../stage-runtime.mjs";
import { toolExecutionFeature } from "../tool-execution/index.mjs";
import { sessionPromptFeature } from "../session-prompt/patches.mjs";
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
	let slowStarted = false;
	let slowClosed = false;
	const server = createServer(async (request, response) => {
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
	};
}

test("media-tools source closure is runtime-owned and carries webfetch, look_at, and the image tools", async () => {
	assert.equal(files.length, 34);
	assert.equal(files.every((entry) => entry.target === "runtime"), true);
	for (const relativePath of [
		"src/imagegen/codex.js",
		"src/imagegen/chain.js",
		"src/imagegen/tool.js",
		"src/openai-web-search/index.js",
		"src/anthropic-bash/index.js",
		"src/host/image-limit.mjs",
	]) {
		assert.equal(
			files.some((entry) => entry.path.endsWith(relativePath)),
			true,
			relativePath,
		);
	}
	assert.equal(files.some((entry) => /openai-image-gen|openai-images|imagegen\/auth/.test(entry.path)), false);
	// The model-core shims stage the real catalog so the image tools follow the picker's Codex row.
	for (const name of ["product-model-catalog.mjs", "model-label.mjs"]) {
		const entry = files.find((candidate) => candidate.path.endsWith(`src/model-core/${name}`));
		assert.equal(entry?.sourcePath, fileURLToPath(new URL(`../../../../packages/model-core/src/${name}`, import.meta.url)));
	}
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

test("staged stock SDK executes webfetch and look_at, and keeps the image tools behind the ChatGPT login", async (t) => {
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
		features: [toolExecutionFeature, sessionPromptFeature, feature],
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
	for (const name of ["image_create", "image_edit"]) {
		assert.equal(typeof session.getToolDefinition(name)?.execute, "function");
		assert.equal(session.getActiveToolNames().includes(name), true);
	}
	assert.equal(session.getToolDefinition("generate_image"), undefined);
	// Without a ChatGPT login the image skill stays out of the prompt.
	assert.equal(resourceLoader.getSkills().skills.some((skill) => skill.name === "gpt-image-gen"), false);

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

	// The fixture agent dir has no ChatGPT login, so both image tools refuse before any request.
	for (const name of ["image_create", "image_edit"]) {
		const refused = await extensionApi.executeTool(name, { prompt: "must not reach a provider", output_path: `${name}.png` });
		assert.equal(refused.details.reason, "missing_config");
		assert.match(textOf(refused), /OpenAI ChatGPT login/);
		assert.equal(existsSync(join(cwd, `${name}.png`)), false);
	}

	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	session = undefined;
});
