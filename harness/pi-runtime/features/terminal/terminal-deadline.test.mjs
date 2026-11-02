import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { getShellConfig } from "./src/host/shell.ts";
import { TerminalManager } from "./src/manager.ts";
import { describeExit } from "./src/tools/spawn.ts";

// 회귀: 명령에 걸린 시간 제한을 네이티브 PTY 가 지키면, 명령이 바로 끝나도 제한 시간 내내 자는
// 스레드가 하나씩 남았다. 엔진에 그런 스레드가 400개쯤 쌓여 있었다(2026-11-02).
const unix = process.platform === "darwin" || process.platform === "linux";
const skip = unix ? false : `thread counting runs on darwin and linux, got ${process.platform}`;

function threadCount() {
	if (process.platform === "linux") return readdirSync("/proc/self/task").length;
	return execFileSync("ps", ["-M", "-p", String(process.pid)], { encoding: "utf8" }).trim().split("\n").length - 1;
}

const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

function harness(t) {
	const cwd = mkdtempSync(join(tmpdir(), "rubato-terminal-deadline-"));
	const manager = new TerminalManager({ maxSessions: 64, scrollback: 100 });
	const shell = getShellConfig();
	t.after(async () => {
		await Promise.race([manager.teardown().catch(() => undefined), delay(2_000)]);
		rmSync(cwd, { recursive: true, force: true });
	});
	const run = async (command, timeoutMs) => {
		const { runtime } = await manager.create(shell.shell, {
			command: shell.shell, args: [...shell.args, command], cwd,
			env: { ...process.env, TERM: "xterm-256color" }, cols: 80, rows: 24, timeoutMs,
		});
		await runtime.session.waitExit();
		return runtime;
	};
	return { run };
}

test("commands that end before their deadline leave no thread or timer behind", { skip }, async (t) => {
	const { run } = harness(t);
	await run("exit 0", 600_000); // loads the native library and its shared threads
	await delay(300);
	const threads = threadCount();
	const pending = timers();
	for (let i = 0; i < 12; i++) assert.equal(describeExit(await run("exit 0", 600_000)), "completed");
	await delay(500);
	assert.ok(threadCount() - threads <= 3, `threads grew from ${threads} to ${threadCount()} after 12 finished commands`);
	assert.equal(timers(), pending, "every deadline timer went with its command");
});

test("a command past its deadline is killed and reported as timed out", { skip }, async (t) => {
	const { run } = harness(t);
	const started = Date.now();
	const runtime = await run("sleep 30", 300);
	assert.ok(Date.now() - started < 5_000, "the deadline ended the command");
	assert.equal(runtime.exitResult.timedOut, true);
	assert.equal(runtime.exitResult.cancelled, true);
	assert.equal(describeExit(runtime), "timed_out");
});
