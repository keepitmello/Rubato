import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { loadPtyNative } from "@code-yeongyu/senpi-pty";
import { getShellConfig } from "./src/host/shell.ts";
import { TerminalManager } from "./src/manager.ts";
import {
	contractPrebuildPath,
	ensureVendoredSenpiPtyPrebuilds,
	senpiPtyPackageRoot,
	vendoredPrebuildPath,
	vendoredPrebuildRoot,
} from "./src/native-prebuild.ts";

const DARWIN_ARM64_PREBUILD_SHA256 = "20f9f1644966694779ee78b76cf60e9f2de2ae0b373a1eb0cf5944afdda0c4da";
const WIN32_X64_PREBUILD_SHA256 = "7e4350f09195b6dd6a919c8924055c14a9c0d765cc8c3dfbfbe7b914be5709b7";

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
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

async function waitUntil(predicate, message, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value) return value;
		await delay(20);
	}
	assert.fail(typeof message === "function" ? message() : message);
}

test("vendored win32-x64 prebuild installs under senpi-pty without replacing darwin-arm64", () => {
	const packageRoot = senpiPtyPackageRoot();
	const darwinPath = contractPrebuildPath(packageRoot, "darwin-arm64");
	assert.equal(existsSync(darwinPath), true, "pinned senpi-pty must still ship darwin-arm64");
	const darwinBefore = sha256File(darwinPath);
	assert.equal(darwinBefore, DARWIN_ARM64_PREBUILD_SHA256);

	const vendorWin32 = vendoredPrebuildPath(vendoredPrebuildRoot(), "win32-x64");
	assert.equal(existsSync(vendorWin32), true);
	assert.equal(sha256File(vendorWin32), WIN32_X64_PREBUILD_SHA256);
	assert.equal(readFileSync(vendorWin32).subarray(0, 2).toString("binary"), "MZ");

	const result = ensureVendoredSenpiPtyPrebuilds();
	assert.equal(result.errors.length, 0, result.errors.join("; "));
	assert.equal(sha256File(darwinPath), darwinBefore);

	const win32Path = contractPrebuildPath(packageRoot, "win32-x64");
	assert.equal(existsSync(win32Path), true);
	assert.equal(sha256File(win32Path), WIN32_X64_PREBUILD_SHA256);
});

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

test(
	"Windows x64 native PTY loads under senpi-pty and runs a real shell command",
	{
		skip:
			process.platform === "win32" && process.arch === "x64"
				? false
				: `win32-x64 native lifecycle runs on Windows x64, got ${process.platform}-${process.arch}`,
	},
	async (t) => {
		const installed = ensureVendoredSenpiPtyPrebuilds();
		assert.equal(installed.errors.length, 0, installed.errors.join("; "));
		const native = loadPtyNative();
		assert.notEqual(native.native, null, native.diagnostic?.cause ?? native.diagnostic?.message);
		assert.equal(native.diagnostic, null);
		assert.equal(native.native.__senpiPtyAbi1(), "1");

		const cwd = mkdtempSync(join(tmpdir(), "rubato-terminal-native-win-"));
		const manager = new TerminalManager({ maxSessions: 2, scrollback: 100 });
		const shell = getShellConfig();
		const marker = "__PTY_WIN__";
		const command =
			shell.kind === "cmd" || shell.kind === "powershell" ? `echo ${marker}` : `printf '%s\\n' '${marker}'`;
		const useStdin = shell.commandTransport === "stdin";
		const args = useStdin ? [...shell.args] : [...shell.args, command];
		let runtime;
		t.after(async () => {
			try {
				runtime?.session.kill("SIGKILL");
			} catch {
				// The successful path already settled the native session.
			}
			await Promise.race([runtime?.session.waitExit().catch(() => undefined), delay(2_000)]);
			await Promise.race([manager.teardown().catch(() => undefined), delay(2_000)]);
			rmSync(cwd, { recursive: true, force: true });
		});

		const created = await manager.create(shell.shell, {
			command: shell.shell,
			args,
			cwd,
			env: { ...process.env, TERM: "xterm-256color" },
			cols: 80,
			rows: 24,
			timeoutMs: 12_000,
		});
		runtime = created.runtime;
		assert.equal(runtime.backend, "native", `expected native backend, got ${runtime.backend}`);
		if (useStdin) {
			assert.equal(runtime.session.write(`${command}\n`).ok, true);
		}
		await waitUntil(
			() => runtime.fullOutput().includes(marker),
			() => `native PTY did not echo marker; output=${JSON.stringify(runtime.fullOutput())}`,
		);
		t.diagnostic(`native windows session via ${shell.shell}`);
	},
);
