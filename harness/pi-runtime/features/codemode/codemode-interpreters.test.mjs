import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { startBridgeServer } from "./src/bridge/http-server.ts";
import { createInterpreterDetector } from "./src/interpreters/detect.ts";
import { resolveCommandPath } from "./src/interpreters/resolve-command.ts";
import { JuliaKernel } from "./src/kernels/jl/kernel.ts";
import { defaultSpawn } from "./src/kernels/py/process.ts";
import { PythonKernel } from "./src/kernels/py/kernel.ts";
import { RubyKernel } from "./src/kernels/rb/kernel.ts";

const detector = createInterpreterDetector();
const detected = {
	py: await detector.detect("py"),
	rb: await detector.detect("rb"),
	jl: await detector.detect("jl"),
};
const bunPath = resolveCommandPath("bun");

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		throw error;
	}
}

async function waitUntil(predicate, message, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(20);
	}
	assert.fail(message);
}

async function waitForProcessExit(pid) {
	await waitUntil(() => !isProcessAlive(pid), `owned interpreter process ${pid} did not exit`);
}

function killOwnedProcess(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !isProcessAlive(pid)) return;
	try {
		if (process.platform === "win32") process.kill(pid, "SIGKILL");
		else process.kill(-pid, "SIGKILL");
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

function pythonSpawnTracker(pids) {
	return (options) => {
		const child = defaultSpawn(options);
		assert.ok(child.pid, "Python child must expose a PID");
		pids.push(child.pid);
		return child;
	};
}

function subprocessSpawnTracker(pids) {
	return (command, args, options) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		assert.ok(child.pid, `${command} child must expose a PID`);
		pids.push(child.pid);
		return child;
	};
}

async function runOwnedCommand(command, args, timeoutMs = 10_000) {
	const cleanEnv = { ...process.env };
	delete cleanEnv.NODE_OPTIONS;
	delete cleanEnv.NODE_COMPILE_CACHE;
	const child = spawn(command, args, {
		cwd: process.cwd(),
		env: cleanEnv,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	assert.ok(child.pid, `${command} child must expose a PID`);
	const pid = child.pid;
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += String(chunk)));
	child.stderr.on("data", (chunk) => (stderr += String(chunk)));
	let timer;
	let result;
	let failure;
	try {
		result = await new Promise((resolveResult, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolveResult({ code, signal }));
			timer = setTimeout(() => {
				killOwnedProcess(pid);
				reject(new Error(`${command} probe exceeded ${timeoutMs}ms; stderr=${stderr.slice(-2_000)}`));
			}, timeoutMs);
		});
	} catch (error) {
		failure = error;
		killOwnedProcess(pid);
	} finally {
		clearTimeout(timer);
		await waitForProcessExit(pid);
	}
	if (failure) throw failure;
	return { ...result, stdout, stderr, pid };
}

async function runInterpreterContract(t, contract) {
	const cwd = mkdtempSync(join(tmpdir(), `rubato-codemode-${contract.language}-`));
	const pids = [];
	const messages = [];
	const calls = [];
	let bridge;
	let kernel;
		t.after(async () => {
		await kernel?.close().catch(() => undefined);
		await bridge?.close().catch(() => undefined);
		for (const pid of pids) killOwnedProcess(pid);
		for (const pid of pids) await waitForProcessExit(pid);
		rmSync(cwd, { recursive: true, force: true });
	});

	bridge = await startBridgeServer({
		onCall: async (request) => {
			calls.push({ name: request.toolName, args: request.args });
			return { echoed: request.args.value };
		},
		onEmit: async () => undefined,
		onCompletion: async () => ({ text: "not used" }),
	});
	const connection = { port: bridge.port, token: bridge.token, parallelPoolWidth: 2 };
	kernel = await contract.start({
		cwd,
		sessionId: `${contract.language}-process-contract`,
		connection,
		onMessage: (message) => messages.push(message),
		pids,
	});

	const first = await kernel.run({ cellId: "persist-1", code: contract.persistFirst });
	assert.equal(first.ok, true, first.ok ? undefined : first.error.message);
	const second = await kernel.run({ cellId: "persist-2", code: contract.persistSecond });
	assert.equal(second.ok, true, second.ok ? undefined : second.error.message);
	assert.match(second.valueRepr ?? "", /42/);

	const toolResult = await kernel.run({ cellId: "tool", code: contract.toolCall });
	assert.equal(toolResult.ok, true, toolResult.ok ? undefined : toolResult.error.message);
	assert.match(toolResult.valueRepr ?? "", /41/);
	assert.deepEqual(calls, [{ name: "echo", args: { value: 41 } }]);

	const interruptedRun = kernel.run({ cellId: "interrupt", code: contract.interruptCode });
	await waitUntil(
		() => calls.some((call) => call.name === "ready" && call.args.value === contract.interruptMarker),
		`${contract.language} interrupt cell did not start; messages=${JSON.stringify(messages.slice(-10))}`,
	);
	const interruption = await kernel.interrupt("process contract probe");
	const interrupted = await interruptedRun;
	assert.equal(interrupted.ok, false);
	assert.match(interrupted.error.message, /interrupt/i);
	assert.equal(await interruption.stateRetained, contract.interruptRetainsState);

	const postInterrupt = await kernel.run({ cellId: "after-interrupt", code: contract.afterInterrupt });
	assert.equal(postInterrupt.ok, contract.interruptRetainsState);
	if (contract.interruptRetainsState) assert.match(postInterrupt.valueRepr ?? "", /41/);

	await kernel.close();
	assert.equal(pids.length >= contract.minimumPidCount, true, `captured PIDs: ${pids.join(", ")}`);
	for (const pid of pids) await waitForProcessExit(pid);
}

test(
	"Python kernel preserves state and tools across cells, interrupts work, and shutdown reaps its process",
	{ skip: detected.py.ok ? false : "python3/python is unavailable" },
	async (t) => {
		await runInterpreterContract(t, {
			language: "py",
			start: (options) =>
				PythonKernel.start({
					interpreterPath: detected.py.path,
					cwd: options.cwd,
					sessionId: options.sessionId,
					connection: options.connection,
					onMessage: options.onMessage,
					spawnProcess: pythonSpawnTracker(options.pids),
				}),
			persistFirst: "saved = 41\nsaved",
			persistSecond: "saved + 1",
			toolCall: 'tool.echo(value=saved)["echoed"]',
			interruptCode: 'tool.ready(value="python-interrupt-ready")\nwhile True:\n    pass',
			interruptMarker: "python-interrupt-ready",
			interruptRetainsState: true,
			afterInterrupt: "saved",
			minimumPidCount: 1,
		});
	},
);

test(
	"Ruby kernel preserves state and tools across cells, restarts on interrupt, and shutdown reaps every process",
	{ skip: detected.rb.ok ? false : "ruby is unavailable" },
	async (t) => {
		await runInterpreterContract(t, {
			language: "rb",
			start: async (options) =>
				RubyKernel.start({
					command: detected.rb.path,
					cwd: options.cwd,
					sessionId: options.sessionId,
					connection: options.connection,
					onMessage: options.onMessage,
					spawn: subprocessSpawnTracker(options.pids),
				}),
			persistFirst: "saved = 41\nsaved",
			persistSecond: "saved + 1",
			toolCall: 'tool.echo(value: saved)["echoed"]',
			interruptCode: 'tool.ready(value: "ruby-interrupt-ready")\nloop { sleep 0.01 }',
			interruptMarker: "ruby-interrupt-ready",
			interruptRetainsState: false,
			afterInterrupt: "saved",
			minimumPidCount: 2,
		});
	},
);

test(
	"Julia kernel preserves state and tools across cells, restarts on interrupt, and shutdown reaps every process",
	{ skip: detected.jl.ok ? false : "julia is unavailable on this host" },
	async (t) => {
		await runInterpreterContract(t, {
			language: "jl",
			start: async (options) =>
				JuliaKernel.start({
					command: detected.jl.path,
					cwd: options.cwd,
					sessionId: options.sessionId,
					connection: options.connection,
					onMessage: options.onMessage,
					spawn: subprocessSpawnTracker(options.pids),
				}),
			persistFirst: "saved = 41\nsaved",
			persistSecond: "saved + 1",
			toolCall: 'tool.echo(Dict("value" => saved))["echoed"]',
			interruptCode: 'tool.ready(Dict("value" => "julia-interrupt-ready"))\nwhile true\n    yield()\nend',
			interruptMarker: "julia-interrupt-ready",
			interruptRetainsState: false,
			afterInterrupt: "saved",
			minimumPidCount: 2,
		});
	},
);

test(
	"Bun-hosted JS kernel persists, bridges tools, aborts, resets state, and lets the Bun process exit",
	{ skip: bunPath === undefined ? "bun is unavailable on this host" : false },
	async () => {
		const driver = fileURLToPath(new URL("./test-bun-kernel.ts", import.meta.url));
		const result = await runOwnedCommand(bunPath, [driver]);
		assert.equal(result.code, 0, `signal=${result.signal}; stderr=${result.stderr}`);
		const summary = JSON.parse(result.stdout.trim());
		assert.equal(summary.ok, true);
		assert.match(summary.bun, /^\d+\.\d+\.\d+/);
		const [major, minor] = summary.bun.split(".").map(Number);
		assert.equal(major > 1 || (major === 1 && minor >= 4), true, `Bun >=1.4 required, got ${summary.bun}`);
		assert.match(summary.mode, /^(?:worker|inline)$/);
		assert.equal(summary.messages > 0, true);
	},
);
