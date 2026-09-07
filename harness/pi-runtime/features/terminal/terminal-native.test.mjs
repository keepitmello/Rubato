import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { loadPtyNative } from "@code-yeongyu/senpi-pty";
import { TerminalManager } from "./src/manager.ts";

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
		const value = predicate();
		if (value) return value;
		await delay(20);
	}
	assert.fail(typeof message === "function" ? message() : message);
}

test(
	"Darwin arm64 native PTY keeps shell state, supports input/screen/resize, and reaps a graceful shell exit",
	{
		skip:
			process.platform === "darwin" && process.arch === "arm64"
				? false
				: `native artifact is only qualified on darwin-arm64, got ${process.platform}-${process.arch}`,
	},
	async (t) => {
		const native = loadPtyNative();
		assert.notEqual(native.native, null, native.diagnostic?.cause);
		assert.equal(native.diagnostic, null);
		assert.equal(native.native.__senpiPtyAbi1(), "1");

		const cwd = mkdtempSync(join(tmpdir(), "rubato-terminal-native-"));
		const manager = new TerminalManager({ maxSessions: 2, scrollback: 100 });
		let shellPid;
		let runtime;
		t.after(async () => {
			try {
				runtime?.session.kill("SIGKILL");
			} catch {
				// The successful path already settled the native session.
			}
			await Promise.race([runtime?.session.waitExit().catch(() => undefined), delay(2_000)]);
			for (const pid of [shellPid]) {
				if (!Number.isSafeInteger(pid) || pid <= 1 || !isProcessAlive(pid)) continue;
				try {
					process.kill(pid, "SIGKILL");
				} catch (error) {
					if (error?.code !== "ESRCH") throw error;
				}
				await waitUntil(() => !isProcessAlive(pid), `cleanup could not reap terminal shell ${pid}`);
			}
			await Promise.race([manager.teardown().catch(() => undefined), delay(2_000)]);
			rmSync(cwd, { recursive: true, force: true });
		});

		const created = await manager.create("/bin/bash", {
			command: "/bin/bash",
			args: ["--noprofile", "--norc"],
			cwd,
			env: { ...process.env, PS1: "", TERM: "xterm-256color" },
			cols: 80,
			rows: 24,
			timeoutMs: 12_000,
		});
		const { id } = created;
		runtime = created.runtime;
		assert.equal(id, "bash_1");
		assert.equal(runtime.backend, "native");
		t.diagnostic("native session started");

		assert.equal(
			runtime.session.write(
				"RUBATO_TERM_VALUE=41; printf '__PTY_ONE__:%s\\n' \"$$\"\n",
			).ok,
			true,
		);
		const firstOutput = await waitUntil(() => {
			const match = /__PTY_ONE__:(\d+)/.exec(runtime.fullOutput());
			return match ?? false;
		}, () => `native PTY did not return its shell and child PIDs; output=${JSON.stringify(runtime.fullOutput())}`);
		shellPid = Number(firstOutput[1]);
		assert.equal(isProcessAlive(shellPid), true);
		t.diagnostic(`persistent shell ready pid=${shellPid}`);

		assert.equal(runtime.session.write('printf "__PTY_TWO__:%s\\n" "$((RUBATO_TERM_VALUE + 1))"\n').ok, true);
		await waitUntil(() => runtime.fullOutput().includes("__PTY_TWO__:42"), "native PTY did not preserve shell state");
		const delta = runtime.readDelta();
		assert.match(delta.text, /__PTY_ONE__:\d+/);
		assert.match(delta.text, /__PTY_TWO__:42/);
		t.diagnostic("state and delta read verified");

		assert.equal(runtime.session.resize(100, 31).ok, true);
		runtime.resizeScreen(100, 31);
		await waitUntil(() => runtime.snapshot().cols === 100 && runtime.snapshot().rows === 31, "screen resize did not settle");
		t.diagnostic("native and screen resize verified");

		assert.equal(runtime.session.write("exit\n").ok, true);
		const exit = await runtime.session.waitExit();
		t.diagnostic(`native exit settled: ${JSON.stringify(exit)}`);
		assert.equal(exit.backend, "native");
		assert.equal(exit.cancelled, false);
		assert.equal(exit.timedOut, false);
		assert.equal(exit.exitCode, 0);
		await waitUntil(() => !isProcessAlive(shellPid), `shell process ${shellPid} survived terminal stop`);
	},
);
