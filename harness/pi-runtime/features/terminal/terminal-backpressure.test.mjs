import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTerminalNative } from "./src/native-prebuild.ts";

const qualified = process.platform === "darwin" && process.arch === "arm64";
test("vendored Darwin input fix matches its source and binary provenance", () => {
	const provenance = JSON.parse(readFileSync(new URL("./native/darwin-provenance.json", import.meta.url), "utf8"));
	const hash = path => createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex");
	assert.equal(hash("./native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node"), provenance.sha256);
	assert.equal(hash("./native/nonblocking-input.patch"), provenance.source.patchSha256);
});
test("qualified PTY build has the nonblocking-input marker", { skip: !qualified }, () => {
	assert.equal(loadTerminalNative().native.__rubatoPtyQueuedInput1(), true);
});

async function runFixture(mode) {
	const child = fork(new URL("./fixtures/input-backpressure.mjs", import.meta.url), [mode], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let terminalPid;
	let responsive;
	let stderr = "";
	child.stderr.on("data", chunk => { stderr += chunk; });
	child.on("message", message => {
		if (message.pid) terminalPid = message.pid;
		if (message.responsive) responsive = message;
	});
	// The watchdog lives OUTSIDE the tested event loop, so the original native deadlock
	// fails instead of hanging node:test and leaving the test terminal behind.
	let timedOut = false;
	const watchdog = setTimeout(() => {
		timedOut = true;
		if (terminalPid) { try { process.kill(terminalPid, "SIGKILL"); } catch {} }
		child.kill("SIGKILL");
	}, 5000);
	try {
		const [code, signal] = await new Promise(resolve => child.once("exit", (...args) => resolve(args)));
		assert.equal(timedOut, false, `PTY write blocked the shared engine event loop. ${stderr}`);
		assert.equal(code, 0, `${signal ?? ""} ${stderr}`);
		assert.equal(responsive?.bounded, true);
		assert.ok(responsive.elapsedMs < 1000, `engine list waited ${responsive.elapsedMs}ms`);
	} finally {
		clearTimeout(watchdog);
		if (terminalPid) { try { process.kill(terminalPid, "SIGKILL"); } catch {} }
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}

test("a full PTY input buffer cannot block engine requests or timers; its queue is bounded", { skip: !qualified }, () => runFixture("blocked"));
test("queued large UTF-8 input is delivered in order without loss; oversized writes fail explicitly", { skip: !qualified }, () => runFixture("flow"));
