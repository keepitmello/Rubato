import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
	assert.equal(files.length, 37);
	assert.equal(files.every((entry) => entry.target === "runtime"), true);
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
