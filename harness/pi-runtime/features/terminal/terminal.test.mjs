import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

async function waitForToolOutput(executeTool, bashId, pattern, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		const result = await executeTool("bash_output", { bash_id: bashId });
		last = textOf(result);
		if (pattern.test(last)) return last;
		await delay(25);
	}
	assert.fail(`terminal output did not match ${pattern}; last=${JSON.stringify(last)}`);
}

async function waitForScreenOutput(executeTool, bashId, pattern, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		const result = await executeTool("bash_output", { bash_id: bashId, view: "screen" });
		last = textOf(result);
		if (pattern.test(last)) return last;
		await delay(25);
	}
	assert.fail(`terminal screen did not match ${pattern}; last=${JSON.stringify(last)}`);
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		throw error;
	}
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await delay(20);
	}
	assert.fail(`terminal-owned process ${pid} did not exit`);
}

test("terminal source closure is runtime-owned and has no dependency on the Senpi application package", async () => {
	assert.equal(files.every((entry) => entry.target === "runtime"), true);
	assert.equal(
		files.some((entry) => entry.path.endsWith("native/prebuilds/win32-x64/senpi_pty.win32-x64.node")),
		true,
	);
	for (const sourceFile of sourceFiles(fileURLToPath(new URL("./src", import.meta.url)))) {
		const source = readFileSync(sourceFile, "utf8");
		assert.doesNotMatch(source, /["']@code-yeongyu\/senpi["']/, `Senpi app import in ${sourceFile}`);
		assert.doesNotMatch(source, /(?:^|["'])\.\.(?:\/\.\.)+\//m, `feature-boundary escape in ${sourceFile}`);
	}
	const module = await import("./src/index.ts");
	assert.equal(typeof module.default, "function");
});

test("staged stock SDK binds terminal tools and preserves a native PTY session across reload", async (t) => {
	const scratch = mkdtempSync(join(tmpdir(), "rubato-terminal-stage-"));
	let session;
	let interactivePid;
	let monitorPid;
	let killPid;
	t.after(async () => {
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" }).catch(() => undefined);
			session.dispose();
		}
		for (const pid of [interactivePid, monitorPid, killPid]) {
			if (!Number.isSafeInteger(pid) || pid <= 1 || !isProcessAlive(pid)) continue;
			try {
				process.kill(pid, "SIGKILL");
			} catch (error) {
				if (error?.code !== "ESRCH") throw error;
			}
			await waitForProcessExit(pid);
		}
		rmSync(scratch, { recursive: true, force: true });
	});

	const outputRoot = join(scratch, "engine");
	const staged = await stagePiRuntime({
		sourceRoot: runtimeRoot,
		outputRoot,
		features: [toolExecutionFeature, feature],
	});
	const terminalFiles = staged.receipt.addedFiles.filter((entry) => entry.feature === "terminal");
	assert.equal(terminalFiles.length, files.length);
	assert.equal(terminalFiles.every((entry) => entry.path.startsWith("rubato-features/terminal/")), true);
	assert.equal(
		terminalFiles.some((entry) => entry.path.endsWith("native/prebuilds/win32-x64/senpi_pty.win32-x64.node")),
		true,
	);

	const stagedEntry = join(outputRoot, "rubato-features/terminal/src/index.ts");
	const terminal = await import(pathToFileURL(stagedEntry).href);
	const ptyManifest = findPackageJSON("@code-yeongyu/senpi-pty", pathToFileURL(stagedEntry));
	assert.equal(JSON.parse(readFileSync(ptyManifest, "utf8")).version, "2026.9.4-3");

	const sdk = await import(pathToFileURL(staged.runtime.sdkEntry).href);
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	let extensionApi;
	const terminalSettings = sdk.SettingsManager.inMemory({
		terminal: {
			defaultCols: 80,
			defaultRows: 24,
			scrollback: 100,
			maxSessions: 4,
			notify: "off",
		},
	});
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: sdk.SettingsManager.inMemory(),
		extensionFactories: [
			{
				name: "rubato-terminal",
				factory: (pi) => {
					extensionApi = pi;
					terminal.default(pi, {
						createSettingsManager: () => terminalSettings,
						getShellEnv: () => ({
							PATH: process.env.PATH,
							HOME: scratch,
							LANG: "C.UTF-8",
							TERM: "xterm-256color",
						}),
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
		settingsManager: sdk.SettingsManager.inMemory(),
		resourceLoader,
		sessionManager: sdk.SessionManager.inMemory(cwd),
	}));
	const extensionErrors = [];
	await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
	assert.deepEqual(extensionErrors, []);
	for (const name of ["bash", "bash_input", "bash_output", "bash_resize", "kill_bash", "monitor"]) {
		assert.equal(typeof session.getToolDefinition(name)?.execute, "function", `${name} definition`);
		assert.equal(session.getActiveToolNames().includes(name), true, `${name} active`);
	}

	const background = await extensionApi.executeTool("bash", {
		command: "bash --noprofile --norc",
		run_in_background: true,
		description: "reload persistence probe",
	});
	const bashId = background.details?.bash_id;
	assert.match(bashId, /^bash_\d+$/);
	await extensionApi.executeTool("bash_input", {
		bash_id: bashId,
		input: "RUBATO_TERM_VALUE=41; printf '__REGISTER__:%s:%s\\n' \"$$\" \"$RUBATO_TERM_VALUE\"",
	});
	const beforeReload = await waitForToolOutput(extensionApi.executeTool.bind(extensionApi), bashId, /__REGISTER__:(\d+):41/);
	interactivePid = Number(/__REGISTER__:(\d+):41/.exec(beforeReload)[1]);
	assert.equal(isProcessAlive(interactivePid), true);

	const priorApi = extensionApi;
	await session.reload();
	assert.notEqual(extensionApi, priorApi);
	await extensionApi.executeTool("bash_input", {
		bash_id: bashId,
		input: "printf '__RELOAD__:%s\\n' \"$((RUBATO_TERM_VALUE + 1))\"",
	});
	await waitForToolOutput(extensionApi.executeTool.bind(extensionApi), bashId, /__RELOAD__:42/);
	const resized = await extensionApi.executeTool("bash_resize", { bash_id: bashId, cols: 100, rows: 31 });
	assert.match(textOf(resized), /100x31/);
	await extensionApi.executeTool("bash_input", {
		bash_id: bashId,
		input: "printf '__SCREEN__:%sx%s\\n' \"$COLUMNS\" \"$LINES\"",
	});
	await waitForScreenOutput(extensionApi.executeTool.bind(extensionApi), bashId, /__SCREEN__:100x31/);
	await extensionApi.executeTool("bash_input", { bash_id: bashId, input: "exit" });
	await waitForProcessExit(interactivePid);

	const monitored = await extensionApi.executeTool("monitor", {
		description: "one-shot monitor probe",
		command: "printf '__MONITOR__:%s\\n' \"$$\"; sleep 0.05",
		filter: "^__MONITOR__:",
		timeout_ms: 2_000,
	});
	assert.match(monitored.details?.monitor_id ?? "", /^mon_[0-9A-Z]{16}$/);
	const monitorBashId = monitored.details?.bash_id;
	assert.match(monitorBashId, /^bash_\d+$/);
	const monitorText = await waitForToolOutput(
		extensionApi.executeTool.bind(extensionApi),
		monitorBashId,
		/__MONITOR__:(\d+)/,
	);
	monitorPid = Number(/__MONITOR__:(\d+)/.exec(monitorText)[1]);
	await waitForProcessExit(monitorPid);

	const killable = await extensionApi.executeTool("bash", {
		command: "printf '__KILL__:%s\\n' \"$$\"; exec sleep 60",
		run_in_background: true,
		description: "single process-group stop probe",
	});
	const killId = killable.details?.bash_id;
	assert.match(killId, /^bash_\d+$/);
	const initialKillText = textOf(killable);
	const killText = /__KILL__:(\d+)/.test(initialKillText)
		? initialKillText
		: `${initialKillText}\n${await waitForToolOutput(extensionApi.executeTool.bind(extensionApi), killId, /__KILL__:(\d+)/)}`;
	killPid = Number(/__KILL__:(\d+)/.exec(killText)[1]);
	assert.equal(isProcessAlive(killPid), true);
	const killed = await extensionApi.executeTool("kill_bash", { bash_id: killId });
	assert.match(textOf(killed), /Killed/);
	await waitForProcessExit(killPid);

	await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
	session.dispose();
	session = undefined;
});

test("a one-shot json run is woken by a background completion and holds only while it is pending", async (t) => {
	const { default: registerTerminal } = await import("./src/extension.ts");
	const { SettingsManager } = await import("./src/host-sdk.ts");
	const scratch = mkdtempSync(join(tmpdir(), "rubato-terminal-oneshot-"));
	const handlers = new Map();
	const rpc = new Map();
	const sent = [];
	let active = [];
	const pi = {
		registerTool() {},
		on: (event, handler) => handlers.set(event, handler),
		rpc: { handle: (name, handler) => rpc.set(name, handler), emit() {} },
		events: { emit() {} },
		sendMessage: (message, options) => sent.push({ message, options }),
		getActiveTools: () => active,
		setActiveTools: (tools) => {
			active = tools;
		},
	};
	const tools = new Map();
	pi.registerTool = (tool) => tools.set(tool.name, tool);
	registerTerminal(pi, {
		createSettingsManager: () => SettingsManager.inMemory({ terminal: { notify: "wake" } }),
		getShellEnv: () => ({ PATH: process.env.PATH, HOME: scratch, LANG: "C.UTF-8", TERM: "xterm-256color" }),
	});
	const ctx = {
		mode: "json",
		cwd: scratch,
		model: { provider: "fixture", id: "fake", api: "openai-completions" },
		ui: { notify() {}, setStatus() {} },
	};
	t.after(async () => {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
		rmSync(scratch, { recursive: true, force: true });
	});
	await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	const pending = () => rpc.get("rubato.terminal.pending-work")();
	assert.deepEqual(pending(), { active: 0, undelivered: 0 });

	const started = await tools.get("bash").execute("call-1", {
		command: "printf 'waiting\\n'; read -t 1 _ || true; printf 'RESULT-X 7\\n'",
		run_in_background: true,
	});
	assert.match(started.details?.bash_id ?? "", /^bash_\d+$/);
	assert.deepEqual(pending(), { active: 1, undelivered: 0 }, "a running background session holds the run");
	const deadline = Date.now() + 5_000;
	while (sent.length === 0 && Date.now() < deadline) await delay(25);
	assert.equal(sent.length, 1, "the completion reaches the agent in json mode");
	assert.match(sent[0].message.content, /RESULT-X 7/);
	assert.equal(sent[0].options.triggerTurn, true);
	assert.deepEqual(pending(), { active: 0, undelivered: 0 });
});

test("a session the agent stops with kill_bash sends no completion notice", async (t) => {
	const { default: registerTerminal } = await import("./src/extension.ts");
	const { SettingsManager } = await import("./src/host-sdk.ts");
	const scratch = mkdtempSync(join(tmpdir(), "rubato-terminal-kill-"));
	const handlers = new Map();
	const rpc = new Map();
	const sent = [];
	const tools = new Map();
	const pi = {
		registerTool: (tool) => tools.set(tool.name, tool),
		on: (event, handler) => handlers.set(event, handler),
		rpc: { handle: (name, handler) => rpc.set(name, handler), emit() {} },
		events: { emit() {} },
		sendMessage: (message, options) => sent.push({ message, options }),
		getActiveTools: () => [],
		setActiveTools() {},
	};
	registerTerminal(pi, {
		createSettingsManager: () => SettingsManager.inMemory({ terminal: { notify: "wake" } }),
		getShellEnv: () => ({ PATH: process.env.PATH, HOME: scratch, LANG: "C.UTF-8", TERM: "xterm-256color" }),
	});
	const ctx = {
		mode: "json",
		cwd: scratch,
		model: { provider: "fixture", id: "fake", api: "openai-completions" },
		ui: { notify() {}, setStatus() {} },
	};
	t.after(async () => {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
		rmSync(scratch, { recursive: true, force: true });
	});
	await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	const pending = () => rpc.get("rubato.terminal.pending-work")();

	const started = await tools.get("bash").execute("call-1", { command: "exec sleep 30", run_in_background: true });
	const id = started.details?.bash_id;
	assert.deepEqual(pending(), { active: 1, undelivered: 0 });
	await tools.get("kill_bash").execute("call-2", { bash_id: id });
	const deadline = Date.now() + 2_000;
	while (pending().active > 0 && Date.now() < deadline) await delay(25);
	await delay(100);
	assert.deepEqual(pending(), { active: 0, undelivered: 0 }, "the stopped session no longer holds the run");
	assert.equal(sent.length, 0, "the agent already knows it stopped the session");
});

test("one-shot holds end for work that has no deadline of its own", async () => {
	const { PERSISTENT_MONITOR_HOLD_MS, UNBOUNDED_BACKGROUND_HOLD_MS, terminalPendingWork } = await import(
		"./src/pending-work.ts"
	);
	const input = {
		delivers: true,
		backgrounds: [
			{ id: "bash_1", startedAtMs: 0, bounded: false },
			{ id: "bash_2", startedAtMs: 0, bounded: true },
		],
		monitors: [
			{ id: "bash_3", startedAtMs: 0, persistent: true, reported: false },
			{ id: "bash_4", startedAtMs: 0, persistent: false, reported: false },
			{ id: "bash_5", startedAtMs: 0, persistent: false, reported: true },
		],
		queuedMonitorEvents: true,
		nowMs: 0,
	};
	assert.deepEqual(terminalPendingWork(input), { active: 4, undelivered: 1 });
	assert.deepEqual(terminalPendingWork({ ...input, nowMs: PERSISTENT_MONITOR_HOLD_MS }), { active: 3, undelivered: 1 });
	assert.deepEqual(terminalPendingWork({ ...input, nowMs: UNBOUNDED_BACKGROUND_HOLD_MS }), { active: 2, undelivered: 1 });
	assert.deepEqual(terminalPendingWork({ ...input, delivers: false }), { active: 0, undelivered: 0 });
});

test("a monitor holds a one-shot json run until it reports, not until its watch command exits", async (t) => {
	const { default: registerTerminal } = await import("./src/extension.ts");
	const { SettingsManager } = await import("./src/host-sdk.ts");
	const scratch = mkdtempSync(join(tmpdir(), "rubato-terminal-oneshot-monitor-"));
	const handlers = new Map();
	const rpc = new Map();
	const sent = [];
	const tools = new Map();
	let active = [];
	const pi = {
		registerTool: (tool) => tools.set(tool.name, tool),
		on: (event, handler) => handlers.set(event, handler),
		rpc: { handle: (name, handler) => rpc.set(name, handler), emit() {} },
		events: { emit() {} },
		sendMessage: (message, options) => sent.push({ message, options }),
		getActiveTools: () => active,
		setActiveTools: (next) => {
			active = next;
		},
	};
	registerTerminal(pi, {
		createSettingsManager: () => SettingsManager.inMemory({ terminal: { notify: "wake" } }),
		getShellEnv: () => ({ PATH: process.env.PATH, HOME: scratch, LANG: "C.UTF-8", TERM: "xterm-256color" }),
	});
	const ctx = {
		mode: "json",
		cwd: scratch,
		model: { provider: "fixture", id: "fake", api: "openai-completions" },
		ui: { notify() {}, setStatus() {} },
	};
	t.after(async () => {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
		rmSync(scratch, { recursive: true, force: true });
	});
	await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	const pending = () => rpc.get("rubato.terminal.pending-work")();

	// The benchmark shape: a gate on a log line whose watch command (`tail -f`) never exits.
	const gate = join(scratch, "gate");
	const started = await tools.get("monitor").execute("call-1", {
		description: "check completion",
		command: `until [ -f '${gate}' ]; do sleep 0.05; done; printf 'EXIT 0\\n'; exec sleep 600`,
		filter: "^EXIT",
		timeout_ms: 600_000,
	});
	assert.match(started.details?.bash_id ?? "", /^bash_\d+$/);
	await delay(300);
	assert.equal(sent.length, 0);
	assert.deepEqual(pending(), { active: 1, undelivered: 0 }, "a monitor the agent is waiting on holds the run");

	writeFileSync(gate, "");
	const deadline = Date.now() + 8_000;
	while (sent.length === 0 && Date.now() < deadline) await delay(25);
	assert.equal(sent.length, 1, "the waited-on event reaches the agent in json mode");
	assert.match(sent[0].message.content, /Monitor event\(check completion\): EXIT 0/);
	assert.deepEqual(pending(), { active: 0, undelivered: 0 }, "once it has reported, a still-running watch no longer holds the run");
});
