import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
	realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

export const WEB_AGENT = "web_agent";
export const DEEP_RESEARCH = "deep_research";
export const RESEARCH_COMPLETION = "rubato:research-completion";
export const researchArtifacts = (sessionFile) => join(`${sessionFile.replace(/\.jsonl$/, "")}-artifacts`, "research");

const activeAside = new Set(["running", "working", "queued", "starting", "waiting", "streaming", "in_progress"]);
const recoverableOutpost = new Set(["submitted_pending", "submit_unknown", "submitted_response_unavailable"]);
const isId = (id) => typeof id === "string" && /^[\w-]{8,80}$/.test(id);
const text = (path) => {
	try { return readFileSync(path, "utf8"); }
	catch (error) { if (error.code === "ENOENT") return ""; throw error; }
};
const json = (path) => {
	try { return JSON.parse(text(path)); }
	catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
};
function save(path, value) {
	const tmp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
	renameSync(tmp, path);
}

function file(cwd, value) {
	const path = realpathSync(resolve(cwd, value));
	if (!statSync(path).isFile()) throw new Error(`Not a regular file: ${value}`);
	return path;
}
const opt = (name, value) => value ? [`--${name}=${value}`] : [];

const exec = promisify(execFile);
async function packEvidence(run, attachments) {
	if (!attachments.length) return [];
	const archive = join(run, "evidence.zip");
	if (attachments.length === 1 && /\.zip$/i.test(attachments[0])) {
		await copyFile(attachments[0], archive);
		return [archive];
	}
	const staging = join(run, "evidence-input");
	mkdirSync(staging, { mode: 0o700 });
	try {
		const names = [];
		for (const [i, source] of attachments.entries()) {
			const name = `${i + 1}-${basename(source)}`;
			await copyFile(source, join(staging, name));
			names.push(name);
		}
		await exec("zip", ["-q", archive, "--", ...names], { cwd: staging, timeout: 60_000 });
		return [archive];
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

export async function prepareResearch(name, params, cwd, run) {
	if (name === WEB_AGENT) {
		const target = [...opt("account", params.account), ...opt("host", params.host)];
		const prompt = params.prompt.trim();
		if (!prompt) throw new Error("A browser task is required.");
		if (["openai/gpt-5.6-sol", "cursor/gpt-5.6-sol"].includes(params.model)) {
			throw new Error("That model is not available on the configured Aside account.");
		}
		return {
			command: "aside",
			args: ["exec", "--json", "--timeout=45m", ...target,
				...opt("profile", params.profile), ...opt("effort", params.effort),
				...opt("model", params.model), "--", prompt],
			recovery: { target },
		};
	}
	const question = params.question.trim();
	if (!question) throw new Error("A research question is required.");
	const attachments = (params.attachments ?? []).map((path) => file(cwd, path));
	const packet = join(run, "packet.md");
	const subject = Array.from(question.split(/\r?\n/, 1)[0].replace(/^#+\s*/, "").trim()).slice(0, 100).join("") || "Research question";
	writeFileSync(packet, `# ${subject}\n\n${question}\n`, { mode: 0o600 });
	const evidence = await packEvidence(run, attachments);
	const quality = params.quality ?? "pro";
	return {
		command: "outpost",
		args: ["send", `--quality=${quality}`, `--run=${run}`, ...opt("to", params.thread),
			...(params.artifact ? [`--artifact=${join(run, "artifact.zip")}`] : []),
			...evidence.map((path) => `--attach=${path}`), "--", packet],
		recovery: { run, quality },
	};
}

// The child retains its output files when the Pi process exits. A reopened
// conversation can wait for that PID or recover from the original engine receipt.
function launch(command, args, cwd, stdout, stderr, done) {
	const out = openSync(stdout, "w", 0o600);
	try {
		const err = openSync(stderr, "w", 0o600);
		try {
			const env = { ...process.env };
			delete env.OUTPOST_FORCE;
			const child = spawn(command, args, {
				cwd, env, detached: process.platform !== "win32", stdio: ["ignore", out, err],
			});
			child.once("error", (error) => done({ error: error.code ?? error.message }));
			child.once("close", (code, signal) => done({ code, signal }));
			child.unref();
			return child.pid ?? null;
		} finally { closeSync(err); }
	} finally { closeSync(out); }
}
function alive(pid) {
	if (!Number.isSafeInteger(pid) || pid < 1) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return error.code === "EPERM"; }
}

function asideResult(path, acceptAnswer = () => true) {
	const result = json(path);
	const session = result?.session;
	const sessionId = [session?.id, session, result?.sessionId, result?.session_id].find(isId);
	const status = session?.status ?? result?.status;
	const outcome = typeof result?.outcome === "string"
		? result.outcome : result?.outcome?.status ?? result?.outcome?.type;
	const answer = result?.answer;
	if (typeof answer === "string" && answer.trim() && !result?.error
		&& !activeAside.has(status) && !/fail|error|interrupt|terminat|timeout|cancel/i.test(`${status} ${outcome}`)
		&& acceptAnswer()) {
		return { ok: true, sessionId, answer };
	}
	return { sessionId, active: activeAside.has(status) };
}

function asideId(stderrPath) {
	// Only accept Aside's session announcement, not incidental IDs in tool logs.
	const lines = text(stderrPath).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	return lines.match(/^\s*(?:aside\s+)?session(?:\s+id)?\s*[:= ]\s*([\w-]{8,80})\s*$/im)?.[1];
}

function outpostResult(job) {
	const receipt = join(job.run, "result.json");
	const result = json(receipt);
	if (!isId(result?.id)) return { receipt };
	if (result.quality !== job.quality) return { receipt, status: "wrong_quality" };
	const response = join(job.run, "response.md");
	if (result.ok === true && result.modelOk === true && existsSync(response) && statSync(response).size > 0) {
		const artifact = join(job.run, "artifact.zip");
		return { ok: true, response, receipt, outpostId: result.id,
			conversationUrl: result.conversationUrl,
			artifact: result.artifactOutput === artifact && existsSync(artifact) ? artifact : undefined };
	}
	return { receipt, outpostId: result.id, status: result.status ?? "unverified_model_or_response" };
}

export function researchJobs({ start = launch, isAlive = alive, now = Date.now, interval = 1_000 } = {}) {
	const jobs = new Map();
	let sessionFile;
	let notify;
	let timer;
	const at = (job, filename) => join(job.dir, filename);
	const stdout = (job) => at(job, `${job.phase}.stdout`);
	const stderr = (job) => at(job, `${job.phase}.stderr`);
	const exit = (job) => at(job, `${job.phase}.exit.json`);

	function spawnPhase(job, phase, command, args) {
		job.phase = phase;
		job.pid = null;
		job.started = now();
		save(at(job, "job.json"), job);
		const exitPath = exit(job);
		const done = (value) => {
			if (!existsSync(exitPath)) save(exitPath, value);
			tick();
		};
		job.pid = start(command, args, job.cwd, stdout(job), stderr(job), done);
		save(at(job, "job.json"), job);
	}

	function advance(job) {
		const ended = json(exit(job));
		if (!ended && (isAlive(job.pid) || (job.pid === null && now() - job.started < 5_000))) return;
		if (job.name === DEEP_RESEARCH) {
			const result = outpostResult(job);
			if (result.ok) return result;
			if (job.phase === "send" && recoverableOutpost.has(result.status)) {
				spawnPhase(job, "recover", "outpost", ["recover", result.receipt]);
				return;
			}
			return { ...result, ok: false, diagnostic: stderr(job),
				error: ended?.error ?? result.status ?? "Outpost left no verified receipt. Nothing was resent." };
		}
		const result = asideResult(stdout(job), () => ended?.code === 0 || !ended);
		if (result.ok) {
			const response = at(job, "response.md");
			writeFileSync(response, result.answer, { mode: 0o600 });
			return { ok: true, response, sessionId: result.sessionId ?? job.sessionId };
		}
		const id = job.sessionId ?? result.sessionId ?? asideId(stderr(job));
		const inspecting = job.phase.startsWith("inspect-");
		if (id && (job.phase === "send" || (inspecting && result.active && now() < job.inspectUntil))) {
			if (inspecting && now() - job.started < 5_000) return;
			job.sessionId = id;
			job.inspectUntil ??= now() + 45 * 60_000;
			const attempt = inspecting ? Number(job.phase.slice("inspect-".length)) + 1 : 1;
			spawnPhase(job, `inspect-${attempt}`, "aside", ["session", "inspect", "--json", ...job.target, id]);
			return;
		}
		return { ok: false, sessionId: id, diagnostic: stderr(job),
			error: ended?.error ?? "Aside did not return a final answer. No second browser task was started." };
	}

	function tick() {
		for (const [id, job] of jobs) {
			let result;
			try {
				result = json(at(job, "final.json"));
				if (!result) {
					result = advance(job);
					if (!result) continue;
					save(at(job, "final.json"), result);
				}
			} catch (error) {
				result = { ok: false, error: error.message };
				save(at(job, "final.json"), result);
			}
			// Drop it before notification, which can synchronously ask about pending work.
			jobs.delete(id);
			notify(job, result);
		}
		if (!jobs.size) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	function watch() {
		if (!timer && jobs.size) {
			timer = setInterval(tick, interval);
			timer.unref?.();
		}
	}

	return {
		get active() { return jobs.size; },
		close() {
			clearInterval(timer);
			timer = undefined;
			jobs.clear();
			sessionFile = undefined;
			notify = undefined;
		},
		open(path, deliver, announced = new Set()) {
			this.close();
			if (!path) return;
			sessionFile = path;
			notify = deliver;
			const root = researchArtifacts(path);
			if (existsSync(root)) {
				for (const id of readdirSync(root)) {
					if (!isId(id) || announced.has(id)) continue;
					const job = json(join(root, id, "job.json"));
					if (job?.id === id && job.dir === join(root, id)
						&& (job.name === WEB_AGENT || job.name === DEEP_RESEARCH)) jobs.set(id, job);
				}
			}
			watch();
		},
		async submit(path, name, params, cwd, toolCallId, signal) {
			if (!path || path !== sessionFile) throw new Error("Open a saved Rubato conversation to start research.");
			const id = name === DEEP_RESEARCH && toolCallId
				? createHash("sha256").update(toolCallId).digest("hex").slice(0, 32) : randomUUID();
			const dir = join(researchArtifacts(path), id);
			const existing = json(join(dir, "job.json"));
			if (existing?.id === id) {
				return { id, ...(existing.run ? { run: existing.run } : {}), existing: true };
			}
			mkdirSync(researchArtifacts(path), { recursive: true, mode: 0o700 });
			try { mkdirSync(dir, { mode: 0o700 }); }
			catch (error) {
				if (error.code === "EEXIST") throw new Error(`Rubato already reserved this research request: ${id}. It will not be resent.`);
				throw error;
			}
			let request;
			try {
				request = await prepareResearch(name, params, cwd, dir);
				signal?.throwIfAborted();
				if (path !== sessionFile) throw new Error("The originating Rubato conversation changed before submission.");
			}
			catch (error) {
				rmSync(dir, { recursive: true, force: true });
				throw error;
			}
			const job = { id, name, dir, cwd, ...request.recovery };
			spawnPhase(job, "send", request.command, request.args);
			jobs.set(id, job);
			watch();
			return { id, ...(job.run ? { run: job.run } : {}) };
		},
	};
}
