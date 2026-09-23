import { ChildProcess, spawn } from "node:child_process";
import type { Socket } from "node:net";

// Kernels run in their own process group so interrupts and shutdown reach
// everything a cell spawns, which also means nothing ties them to the host. A
// runner only notices a dead host when it reads stdin EOF, and a cell stuck in
// a loop never reads it: a host that dies mid-cell (crash, SIGKILL, a killed
// test run) leaves the kernel spinning with no owner. One reaper per host holds
// a pipe from the host and kills every registered kernel tree once that pipe
// closes, whatever the kernel language or whatever the cell is doing.
const reaperSource = `
const { spawnSync } = require("node:child_process");
const pids = new Set();
let pending = "";
const reap = () => {
	for (const pid of pids) {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			continue;
		}
		try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
	}
	process.exit(0);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	const lines = (pending + chunk).split("\\n");
	pending = lines.pop();
	for (const line of lines) {
		const pid = Number(line.slice(1));
		if (!Number.isSafeInteger(pid) || pid <= 1) continue;
		if (line[0] === "+") pids.add(pid);
		else if (line[0] === "-") pids.delete(pid);
	}
});
process.stdin.on("end", reap);
process.stdin.on("error", reap);
`;

const livePids = new Set<number>();
let reaper: ChildProcess | null = null;
// A reaper that failed once stays off for this host: protection is best effort
// and must never turn into a respawn loop or block kernel startup.
let reaperUnavailable = false;

/** Kill `child`'s process tree when this host process goes away without shutting it down. */
export function bindToHostLifetime(child: unknown): void {
	// Injected test doubles carry made-up PIDs; only a real child may be registered.
	if (!(child instanceof ChildProcess) || child.pid === undefined) return;
	if (child.exitCode !== null || child.signalCode !== null) return;
	const pid = child.pid;
	livePids.add(pid);
	sendToReaper(`+${pid}`);
	child.once("exit", () => {
		livePids.delete(pid);
		sendToReaper(`-${pid}`);
	});
}

function sendToReaper(line: string): void {
	const stdin = ensureReaper()?.stdin;
	if (stdin?.writable) stdin.write(`${line}\n`);
}

function ensureReaper(): ChildProcess | null {
	if (reaper || reaperUnavailable) return reaper;
	let child: ChildProcess;
	try {
		child = spawn(process.execPath, ["-e", reaperSource], {
			stdio: ["pipe", "ignore", "ignore"],
			// Its own group keeps a signal aimed at the host's group from taking the reaper down with it.
			detached: process.platform !== "win32",
			env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
			windowsHide: true,
		});
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		reaperUnavailable = true;
		return null;
	}
	const retire = () => {
		if (reaper === child) reaper = null;
		reaperUnavailable = true;
	};
	child.once("error", retire);
	child.once("exit", retire);
	child.stdin?.once("error", retire);
	// The reaper must never keep the host alive.
	child.unref();
	(child.stdin as Socket | null)?.unref();
	reaper = child;
	for (const pid of livePids) child.stdin?.write(`+${pid}\n`);
	return child;
}
