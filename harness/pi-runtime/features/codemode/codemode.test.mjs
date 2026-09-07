import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";

import { stagePiRuntime } from "../../stage-runtime.mjs";
import { toolExecutionFeature } from "../tool-execution/index.mjs";
import { feature, files } from "./patches.mjs";
import { defaultCodemodeSettings } from "./src/config/settings.ts";
import { createExecuteTool } from "./src/extension/runtime-factory.ts";
import { createCodemodeSessionManager } from "./src/extension/session-manager.ts";
import { EvalDetachedCellManager } from "./src/tool/detached-cell-manager.ts";
import { createEvalTool } from "./src/tool/eval-tool.ts";

const expectedAssets = [
	"LICENSE",
	"src/kernels/js/worker-entry.js",
	"src/kernels/js/inline-worker-entry.js",
	"src/kernels/js/worker-core.js",
	"src/kernels/js/worker-runtime.js",
	"src/kernels/js/worker-indirect-eval.js",
	"src/kernels/js/worker-shell-capture.js",
	"src/kernels/py/prelude.py",
	"src/kernels/rb/runner.rb",
	"src/kernels/rb/prelude.rb",
	"src/kernels/jl/runner.jl",
	"src/kernels/jl/prelude.jl",
	"src/skill/bun-1-4/SKILL.md",
];
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function textOf(result) {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function runEval(definition, id, params, context, onUpdate) {
	return definition.execute(id, params, new AbortController().signal, onUpdate, context);
}

function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
	});
}

test("owned codemode tree contains every runtime asset and no Senpi runtime import", async () => {
	for (const relativePath of expectedAssets) {
		assert.doesNotThrow(() => readFileSync(new URL(relativePath, import.meta.url)));
	}

	for (const sourceFile of sourceFiles(fileURLToPath(new URL("./src", import.meta.url)))) {
		assert.doesNotMatch(
			readFileSync(sourceFile, "utf8"),
			/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']@code-yeongyu\/senpi/,
			`Senpi runtime import in ${sourceFile}`,
		);
	}

	const entry = await import("./src/index.ts");
	assert.equal(typeof entry.default, "function");
	assert.equal(typeof entry.enabledLanguagesFrom, "function");
	const assets = await import("./src/kernels/shared/runtime-asset.ts");
	assert.equal(
		assets.resolveCodemodeRuntimeAsset("/owned/missing", "kernels/js/worker-entry.js", {
			bunVersion: "1.4.0",
			executablePath: "/external/senpi",
		}),
		"/owned/missing",
	);
});

test("stager installs the complete codemode feature in the runtime-owned dependency boundary", async (t) => {
	const scratch = mkdtempSync(join(tmpdir(), "rubato-codemode-stage-"));
	let session;
	t.after(async () => {
		if (session !== undefined) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
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
	const codemodeFiles = staged.receipt.addedFiles.filter((entry) => entry.feature === "codemode");
	assert.equal(codemodeFiles.length, files.length);
	assert.equal(files.length, 99);
	assert.equal(codemodeFiles.every((entry) => entry.target === "runtime"), true);
	assert.equal(codemodeFiles.every((entry) => entry.path.startsWith("rubato-features/codemode/")), true);

	const stagedEntry = join(outputRoot, "rubato-features/codemode/src/index.ts");
	const module = await import(pathToFileURL(stagedEntry).href);
	assert.equal(typeof module.default, "function");
	for (const [packageName, version] of [
		["@babel/parser", "8.0.4"],
		["typebox", "1.3.18"],
	]) {
		const manifest = findPackageJSON(packageName, pathToFileURL(stagedEntry));
		assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, version);
	}

	const sdk = await import(pathToFileURL(staged.runtime.sdkEntry).href);
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	mkdirSync(join(cwd, ".senpi"), { recursive: true });
	mkdirSync(agentDir);
	writeFileSync(
		join(cwd, ".senpi", "codemode.json"),
		JSON.stringify({
			languages: { py: false, js: true, rb: false, jl: false },
			cellTimeoutSeconds: 10,
			foregroundWindowSeconds: 10,
			hardLimitSeconds: 15,
		}),
	);
	let extensionApi;
	let lazyActivations = 0;
	const settingsManager = sdk.SettingsManager.inMemory();
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{
				name: "rubato-codemode",
				factory: (pi) => {
					extensionApi = pi;
					module.default(pi, {
						complete: async () => {
							throw new Error("provider completion is outside this local integration test");
						},
					});
				},
			},
			{
				name: "codemode-echo",
				factory: (pi) => {
					pi.registerTool({
						name: "echo",
						label: "Echo",
						description: "Return one number",
						parameters: Type.Object({ value: Type.Number() }),
						execute: async (_id, params, _signal, onUpdate) => {
							onUpdate?.({ content: [{ type: "text", text: "echo update" }], details: {} });
							return { content: [{ type: "text", text: `echo:${params.value}` }], details: {} };
						},
					});
					pi.registerLazyToolActivator((name) => {
						if (name !== "echo") return false;
						lazyActivations += 1;
						pi.setActiveTools([...pi.getActiveTools(), name]);
						return true;
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
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	({ session } = await sdk.createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: sdk.SessionManager.inMemory(cwd),
	}));
	await session.bindExtensions({ mode: "print" });
	assert.equal(typeof session.getToolDefinition("eval")?.execute, "function");
	session.setActiveToolsByName(["eval"]);
	const stockFirst = await extensionApi.executeTool("eval", {
		language: "js",
		code: "globalThis.stockBound = 6; stockBound * 7",
		summary: "stock factory first cell",
	});
	assert.match(textOf(stockFirst), /42/);
	const stockSecond = await extensionApi.executeTool("eval", {
		language: "js",
		code: "stockBound + 1",
		summary: "stock factory second cell",
	});
	assert.match(textOf(stockSecond), /7/);
	const stockUpdates = [];
	const stockTool = await extensionApi.executeTool(
		"eval",
		{
			language: "js",
			code: "await tool.echo({ value: stockBound })",
			summary: "stock generic tool bridge",
		},
		{ onUpdate: (update) => stockUpdates.push(update) },
	);
	assert.match(textOf(stockTool), /echo/);
	assert.equal(lazyActivations, 1);
	assert.equal(stockUpdates.length > 0, true);

	const [hinted] = await session.extensionRunner.emitContext([
		{
			role: "toolResult",
			toolCallId: "missing-exec",
			toolName: "exec",
			content: [{ type: "text", text: "Tool exec not found" }],
			isError: true,
			timestamp: Date.now(),
		},
	]);
	assert.match(hinted.content[0].text, /use eval/);
});

test("persistent JS eval composes generic tools, detach control, notifications, and shutdown", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "rubato-codemode-js-"));
	const calls = [];
	const notifications = [];
	const host = {
		getActiveTools: () => ["echo"],
		async executeTool(name, params, options = {}) {
			calls.push({ name, params, options });
			options.onUpdate?.({ content: [{ type: "text", text: "host update" }], details: { status: "running" } });
			return {
				content: [{ type: "text", text: `${name}:${JSON.stringify(params)}` }],
				details: { name, params },
			};
		},
	};
	const executeTool = createExecuteTool(host);
	const directController = new AbortController();
	const directUpdates = [];
	await executeTool("echo", { direct: true }, { signal: directController.signal, onUpdate: (update) => directUpdates.push(update) });
	assert.equal(calls[0].options.activateInactiveTool, true);
	assert.equal(calls[0].options.signal, directController.signal);
	assert.equal(directUpdates.length, 1);
	calls.length = 0;

	const settings = {
		...defaultCodemodeSettings,
		languages: { py: false, js: true, rb: false, jl: false },
		cellTimeoutSeconds: 10,
		foregroundWindowSeconds: 10,
		hardLimitSeconds: 15,
		parallelPoolWidth: 2,
	};
	const availability = {
		py: { enabled: false, detected: { ok: false } },
		js: {
			enabled: true,
			detected: { ok: true, path: "node", version: process.versions.node, resolvedPath: process.execPath },
		},
		rb: { enabled: false, detected: { ok: false } },
		jl: { enabled: false, detected: { ok: false } },
	};
	const listTools = () => [
		{
			name: "echo",
			description: "returns its input",
			parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
		},
	];
	const manager = await createCodemodeSessionManager({
		sessionId: "codemode-test",
		cwd,
		settings,
		availability,
		executeTool,
		listTools,
		complete: async () => {
			throw new Error("completion is outside this local test");
		},
	});
	const cells = new EvalDetachedCellManager({
		artifactsDir: cwd,
		hardLimitSeconds: 3,
		notifier: { notify: (entries) => notifications.push(...entries) },
	});
	const definition = createEvalTool({
		enabledLanguages: settings.languages,
		kernelManager: manager,
		cellTimeoutSeconds: settings.cellTimeoutSeconds,
		foregroundWindowSeconds: settings.foregroundWindowSeconds,
		executeTool,
		listTools,
		settings,
		artifactsDir: cwd,
		cellManager: cells,
	});
	const detachDefinition = createEvalTool({
		enabledLanguages: settings.languages,
		kernelManager: manager,
		cellTimeoutSeconds: settings.cellTimeoutSeconds,
		foregroundWindowSeconds: 0.05,
		executeTool,
		listTools,
		settings,
		artifactsDir: cwd,
		cellManager: cells,
	});
	const context = { cwd, mode: "tui" };

	try {
		const first = await runEval(
			definition,
			"cell-1",
			{ language: "js", code: "globalThis.saved = 41; saved", summary: "값 저장" },
			context,
		);
		assert.match(textOf(first), /41/);

		const second = await runEval(
			definition,
			"cell-2",
			{ language: "js", code: "saved + 1", summary: "저장 값 읽기" },
			context,
		);
		assert.match(textOf(second), /42/);

		const evalUpdates = [];
		const nested = await runEval(
			definition,
			"cell-tool",
			{ language: "js", code: "await tool.echo({ value: saved })", summary: "도구 호출" },
			context,
			(update) => evalUpdates.push(update),
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].name, "echo");
		assert.deepEqual(calls[0].params, { value: 41 });
		assert.equal(calls[0].options.activateInactiveTool, true);
		assert.equal(calls[0].options.signal instanceof AbortSignal, true);
		assert.equal(evalUpdates.length > 0, true);
		assert.match(textOf(nested), /echo/);
		assert.equal(nested.details.toolCalls[0].ok, true);

		const detached = await runEval(
			detachDefinition,
			"cell-detached",
			{ language: "js", code: "await new Promise(() => {})", summary: "분리 실행", timeout: 1 },
			context,
		);
		assert.match(textOf(detached), /detached and is still running/);

		const peeked = await runEval(
			detachDefinition,
			"peek-call",
			{ action: "peek", cell_id: "cell-detached" },
			context,
		);
		assert.match(textOf(peeked), /is detached/);

		const stopped = await runEval(
			detachDefinition,
			"stop-call",
			{ action: "stop", cell_id: "cell-detached" },
			context,
		);
		assert.match(textOf(stopped), /is cancelled/);
		assert.match(textOf(stopped), /restarted; variables from earlier cells are lost/);
		await cells.flushNotifications();
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].cellId, "cell-detached");

		const kernel = await manager.getKernel("js", () => {});
		await cells.dispose();
		await manager.dispose();
		await assert.rejects(kernel.run({ cellId: "after-shutdown", code: "1" }), /closed/);
		assert.throws(() => manager.bridgeEndpoint(), /not running/);
	} finally {
		await cells.dispose();
		await manager.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
