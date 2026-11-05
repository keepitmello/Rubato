import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { TerminalSession } from "@code-yeongyu/senpi-pty";
import { TerminalRuntimeSession } from "../src/runtime-session.ts";
import { startSessionServer } from "../../../../pi-server/src/host.mjs";
import { SessionClient } from "../../../../pi-server/src/client.mjs";

const scratch = await mkdtemp(join(tmpdir(), "rubato-pty-backpressure-"));
const flow = process.argv[2] === "flow";
const payload = Buffer.from("입력순서와 UTF-8 preservation\n".repeat(8192));
const reader = `let b=Buffer.alloc(0);console.log("READY:"+process.pid);process.stdin.on("data",c=>{b=Buffer.concat([b,c]);if(b.length>=${payload.length}){console.log("HASH:"+require("node:crypto").createHash("sha256").update(b).digest("hex"));process.exit(0)}})`;
const command = flow ? `stty raw -echo; exec "${process.execPath}" -e '${reader}'`
	: "stty raw -echo; printf 'READY:%s\\n' $$; exec sleep 30";
const options = { command: "/bin/sh", args: ["-c", command],
	cwd: scratch, env: process.env, cols: 80, rows: 24 };
const runtime = process.env.RUBATO_TEST_BASELINE_PTY ? null : new TerminalRuntimeSession("blocked reader", options);
const session = runtime?.session ?? new TerminalSession(options);
let output = runtime?.fullOutput() ?? "";
session.onData(chunk => { output += chunk.toString(); });
if (!runtime) session.start();
let server;
let client;
try {
	while (!/READY:(\d+)/.test(output)) await delay(10);
	process.send({ pid: Number(/READY:(\d+)/.exec(output)[1]) });
	server = await startSessionServer({ sessionsDir: join(scratch, "sessions"), socketPath: join(scratch, "pi.sock") });
	client = await new SessionClient({ socketPath: join(scratch, "pi.sock"), serverId: server.serverId, timeoutMs: 1000 }).connect();
	// This exceeds the PTY input buffer. The original native build never returns from write,
	// which also starves the shared engine's socket and every timer on its JavaScript thread.
	const started = performance.now();
	if (flow) {
		const oversized = session.write("z".repeat(1024 * 1024 + 1));
		if (oversized.ok || !/exceeds 1 MiB/.test(oversized.note)) throw new Error("Oversized input was not rejected explicitly");
		for (let offset = 0; offset < payload.length; offset += 32768) {
			const result = session.write(payload.subarray(offset, offset + 32768));
			if (!result.ok) throw new Error(result.note);
		}
		await session.waitExit();
		const expected = createHash("sha256").update(payload).digest("hex");
		if (!output.includes(`HASH:${expected}`)) throw new Error(`Input was lost or reordered: ${output}`);
		await client.list();
		process.send({ responsive: true, bounded: true, elapsedMs: performance.now() - started });
	} else {
	const initial = session.write("x".repeat(512 * 1024));
	if (!initial.ok) throw new Error(`Input rejected (${session.backend}): ${JSON.stringify(initial)}`);
	await delay(25);
	await client.list();
	let full = false;
	for (let i = 0; i < 32; i++) {
		try {
			const result = session.write("y".repeat(64 * 1024));
			if (!result.ok) {
				if (!/queue is full/.test(result.note)) throw new Error(`Unexpected input rejection: ${result.note}`);
				full = true; break;
			}
		}
		catch (error) { if (!/queue is full/.test(error.message)) throw error; full = true; break; }
	}
	if (!full) throw new Error("Backpressure never rejected a full input queue");
	await client.list();
	process.send({ responsive: true, elapsedMs: performance.now() - started, bounded: full });
	}
} finally {
	session.kill("SIGKILL");
	await session.waitExit();
	await client?.close();
	await server?.close();
	runtime?.dispose();
	await rm(scratch, { recursive: true, force: true });
}
process.disconnect();
