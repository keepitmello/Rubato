import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { collectPendingWork } from "../extension-rpc/runtime.mjs";
import { ToolSearchService } from "../tool-search/service.mjs";
import { registerResearchTools } from "./src/research/index.mjs";
import { DEEP_RESEARCH, RESEARCH_COMPLETION, BROWSER_AGENT, researchArtifacts, researchJobs } from "./src/research/jobs.mjs";

const asideId = "OKVEKoXp6OTEmbpS";
const outpostId = "outpost-fixture-request";
const receipt = (overrides = {}) => ({
	id: outpostId, quality: "pro", ok: true, modelOk: true, ...overrides,
});
const put = (path, object) => writeFileSync(path, JSON.stringify(object));

function fixture(t) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "rubato-research-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const transcript = join(cwd, "conversation.jsonl");
	const otherTranscript = join(cwd, "another.jsonl");
	const calls = [];
	const pids = new Set();
	const jobHarness = () => {
		const harness = researchJobs({
			interval: 10,
			inlineRoot: () => join(cwd, "inline"),
			isAlive: (pid) => pids.has(pid),
			start(command, args, _cwd, out, err, done) {
				const pid = calls.length + 100;
				pids.add(pid);
				calls.push({
					command, args, out, err, pid,
					finish(code = 0) { pids.delete(pid); done({ code }); },
				});
				return pid;
			},
		});
		t.after(() => harness.close());
		return harness;
	};
	return { cwd, transcript, otherTranscript, calls, pids, jobHarness };
}

async function until(predicate) {
	for (let i = 0; i < 40; i++) {
		if (predicate()) return;
		await sleep(10);
	}
	assert.fail("timed out waiting for research result");
}

test("native tools are search-exposed and research work holds one-shot sessions", async (t) => {
	const { cwd, transcript, calls, jobHarness } = fixture(t);
	const hooks = new Map();
	const tools = new Map();
	const rpcHandlers = new Map();
	const entries = [];
	const sent = [];
	const ctx = { cwd, sessionManager: { getSessionFile: () => transcript, getEntries: () => entries } };
	registerResearchTools({
		on: (event, cb) => hooks.set(event, cb),
		registerTool: (value) => tools.set(value.name, value),
		rpc: { handle: (name, callback) => rpcHandlers.set(name, callback) },
		sendMessage(message, options) {
			sent.push({ message, options });
			entries.push({ type: "custom_message", ...message });
		},
	}, jobHarness());
	assert.deepEqual([...tools.keys()], [BROWSER_AGENT, DEEP_RESEARCH]);
	assert.ok([...tools.values()].every((tool) => tool.exposure === "search"));
	const search = new ToolSearchService();
	search.bindRuntime({
		getAllTools: () => [...tools.values()].map((tool) => ({
			...tool, sourceInfo: { path: "research/index.mjs" }, searchKeywords: [], allowLazyActivation: true,
		})),
		getActiveTools: () => [],
	});
	assert.equal(search.search("browser_agent")[0]?.name, BROWSER_AGENT);
	assert.equal(search.search("deep_research")[0]?.name, DEEP_RESEARCH);
	hooks.get("session_start")({}, ctx);
	const task = "find the source; echo do not run this as shell";
	const result = await tools.get(BROWSER_AGENT).execute("call-1", { prompt: task, effort: "high" }, undefined, undefined, ctx);
	assert.equal(result.details.status, "running");
	assert.equal(calls[0].command, "aside");
	assert.deepEqual(calls[0].args.slice(-3), ["--effort=high", "--", task]);
	assert.deepEqual(await collectPendingWork([{ rpcHandlers }], () => {}), { active: 1, undelivered: 0 });
	put(calls[0].out, { session: { id: asideId, status: "idle" }, answer: "[Source](https://example.org)" });
	calls[0].finish();
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, RESEARCH_COMPLETION);
	assert.equal(sent[0].message.details.id, result.details.id);
	assert.match(sent[0].message.content, /\[Source\]\(https:\/\/example.org\)/);
	assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.deepEqual(await collectPendingWork([{ rpcHandlers }], () => {}), { active: 0, undelivered: 0 });
	hooks.get("session_shutdown")();
	hooks.get("session_start")({}, ctx);
	await sleep(30);
	assert.equal(sent.length, 1);
});

test("separate research questions in one conversation run in parallel", async (t) => {
	const { cwd, transcript, calls, jobHarness } = fixture(t);
	const tools = new Map();
	const ctx = { cwd, sessionManager: { getSessionFile: () => transcript, getEntries: () => [] } };
	const hooks = new Map();
	registerResearchTools({
		on: (event, cb) => hooks.set(event, cb),
		registerTool: (value) => tools.set(value.name, value),
		sendMessage() {},
	}, jobHarness());
	hooks.get("session_start")({}, ctx);
	const deep = tools.get(DEEP_RESEARCH);
	const web = tools.get(BROWSER_AGENT);
	const started = await Promise.all([
		deep.execute("call-a", { question: "first topic" }, undefined, undefined, ctx),
		deep.execute("call-b", { question: "second topic" }, undefined, undefined, ctx),
		web.execute("call-c", { prompt: "third topic" }, undefined, undefined, ctx),
		web.execute("call-d", { prompt: "fourth topic" }, undefined, undefined, ctx),
	]);
	assert.ok(started.every((result) => result.details.status === "running"));
	assert.equal(new Set(started.map((result) => result.details.id)).size, 4);
	assert.deepEqual(calls.map((call) => `${call.command} ${call.args[0]}`).sort(),
		["aside exec", "aside exec", "outpost send", "outpost send"]);
	for (const result of started) {
		assert.doesNotMatch(result.content[0].text, /second run/);
		assert.match(result.content[0].text, /different question can run alongside/);
	}
});

test("Aside interruption inspects the same session without a second exec", async (t) => {
	const { cwd, transcript, calls, jobHarness } = fixture(t);
	const harness = jobHarness();
	const results = [];
	harness.open(transcript, (_, result) => results.push(result));
	await harness.submit(transcript, BROWSER_AGENT, { prompt: "read", account: "u1", host: "local" }, cwd);
	writeFileSync(calls[0].err, `\x1b[90mSession: ${asideId}\x1b[0m\n`);
	calls[0].finish(1);
	assert.deepEqual(calls[1].args, ["session", "inspect", "--json", "--account=u1", "--host=local", asideId]);
	put(calls[1].out, { session: { id: asideId, status: "idle" }, answer: "original answer" });
	calls[1].finish();
	assert.equal(results.length, 1);
	assert.equal(results[0].sessionId, asideId);
	assert.equal(readFileSync(results[0].response, "utf8"), "original answer");
	assert.equal(calls.filter((call) => call.args[0] === "exec").length, 1);
});

test("an interrupted Outpost reopens on its original conversation and only recovers", async (t) => {
	const { cwd, transcript, otherTranscript, calls, pids, jobHarness } = fixture(t);
	const first = jobHarness();
	const attachment = join(cwd, "explicit input.txt");
	writeFileSync(attachment, "evidence");
	first.open(transcript, () => assert.fail("closed conversation was notified"));
	const params = { question: "Which approach?\n\nResearch scope", attachments: [attachment], artifact: true };
	const job = await first.submit(transcript, DEEP_RESEARCH, params, cwd, "research-call");
	const { run } = job;
	assert.equal(readFileSync(join(run, "packet.md"), "utf8"), "# Which approach?\n\nWhich approach?\n\nResearch scope\n");
	const archive = join(run, "evidence.zip");
	assert.ok(calls[0].args.includes(`--attach=${archive}`));
	assert.equal(execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim(), "1-explicit input.txt");
	assert.equal(execFileSync("unzip", ["-p", archive, "1-explicit input.txt"], { encoding: "utf8" }), "evidence");
	assert.ok(calls[0].args.includes(`--artifact=${join(run, "artifact.zip")}`));
	assert.equal((await first.submit(transcript, DEEP_RESEARCH, params, cwd, "research-call")).existing, true);
	const path = join(run, "result.json");
	put(path, receipt({ ok: false, status: "submitted_pending" }));
	first.close();
	const afterRestart = jobHarness();
	afterRestart.open(otherTranscript, () => assert.fail("wrong conversation was notified"));
	await sleep(30);
	assert.equal(calls.length, 1);
	const deliveries = [];
	afterRestart.open(transcript, (owner, result) => deliveries.push({ owner, result }));
	await sleep(30);
	assert.equal(calls.length, 1, "must not recover while the sender is still alive");
	pids.delete(calls[0].pid);
	await until(() => calls.length === 2);
	assert.deepEqual(calls[1].args, ["recover", path]);
	writeFileSync(join(run, "response.md"), "original Pro response");
	put(path, receipt());
	calls[1].finish();
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0].owner.id, job.id);
	assert.equal(readFileSync(deliveries[0].result.response, "utf8"), "original Pro response");
	assert.equal(calls.filter((call) => call.args[0] === "send").length, 1);
	assert.equal((await afterRestart.submit(transcript, DEEP_RESEARCH, params, cwd, "research-call")).existing, true);
	assert.equal(calls.length, 2);
});

test("a browser task saved under the old web_agent name still reports back", async (t) => {
	const { cwd, transcript, calls, pids, jobHarness } = fixture(t);
	const first = jobHarness();
	first.open(transcript, () => assert.fail("closed conversation was notified"));
	const { id } = await first.submit(transcript, BROWSER_AGENT, { prompt: "read" }, cwd);
	const saved = join(researchArtifacts(transcript), id, "job.json");
	put(saved, { ...JSON.parse(readFileSync(saved, "utf8")), name: "web_agent" });
	first.close();
	put(calls[0].out, { session: { id: asideId, status: "idle" }, answer: "answer from before the rename" });
	pids.delete(calls[0].pid);
	const deliveries = [];
	jobHarness().open(transcript, (owner, result) => deliveries.push({ owner, result }));
	await until(() => deliveries.length === 1);
	assert.equal(deliveries[0].owner.name, BROWSER_AGENT);
	assert.equal(readFileSync(deliveries[0].result.response, "utf8"), "answer from before the rename");
	assert.equal(calls.length, 1);
});

test("an unverified Outpost result is a failure and never resubmits", async (t) => {
	const { cwd, transcript, calls, jobHarness } = fixture(t);
	const results = [];
	const harness = jobHarness();
	harness.open(transcript, (_, result) => results.push(result));
	await assert.rejects(harness.submit(transcript, DEEP_RESEARCH,
		{ question: "question", attachments: ["unknown.txt"] }, cwd), /ENOENT/);
	assert.equal(calls.length, 0);
	const { id, run } = await harness.submit(transcript, DEEP_RESEARCH, { question: "question" }, cwd);
	assert.ok(!calls[0].args.some((arg) => arg.startsWith("--attach")));
	assert.ok(existsSync(join(researchArtifacts(transcript), id, "job.json")));
	const state = join(run, "result.json");
	put(state, receipt({ ok: false, modelOk: false }));
	writeFileSync(join(dirname(state), "response.md"), "not the requested model");
	calls[0].finish(78);
	assert.equal(results[0].ok, false);
	assert.match(results[0].error, /unverified/);
	assert.equal(calls.length, 1);
});

test("a real subprocess can complete after its original job watcher closes", {
	skip: process.platform === "win32",
}, async (t) => {
	const { cwd, transcript } = fixture(t);
	const bin = join(cwd, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "aside"), `#!/bin/sh
test "$1" = exec || exit 2
sleep 0.05
printf '%s\\n' '${JSON.stringify({ session: { id: asideId, status: "idle" }, answer: "durable answer" })}'
`, { mode: 0o700 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	t.after(() => { process.env.PATH = previousPath; });
	const before = researchJobs({ interval: 10 });
	const after = researchJobs({ interval: 10 });
	t.after(() => { before.close(); after.close(); });
	before.open(transcript, () => assert.fail("the original watcher is closed"));
	const { id } = await before.submit(transcript, BROWSER_AGENT, { prompt: "check persistence" }, cwd);
	before.close();
	const delivered = [];
	after.open(transcript, (job, result) => delivered.push({ job, result }));
	await until(() => delivered.length === 1);
	assert.equal(delivered[0].job.id, id);
	assert.equal(readFileSync(delivered[0].result.response, "utf8"), "durable answer");
});

function inlineTools(t) {
	const f = fixture(t);
	const tools = new Map();
	registerResearchTools({
		on() {}, registerTool: (value) => tools.set(value.name, value), sendMessage() {},
	}, f.jobHarness());
	// A session without a transcript file, as in the MCP bridge.
	const ctx = { cwd: f.cwd, sessionManager: { getSessionFile: () => undefined, getEntries: () => [] } };
	return { ...f, tools, ctx };
}

test("a session with no saved transcript waits and returns the browser result", async (t) => {
	const { calls, tools, ctx } = inlineTools(t);
	const pending = tools.get(BROWSER_AGENT).execute("call", { prompt: "read the page" }, undefined, undefined, ctx);
	await until(() => calls.length === 1);
	put(calls[0].out, { session: { id: asideId, status: "idle" }, answer: "page says hello" });
	calls[0].finish();
	const result = await pending;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /browser_agent completed\./);
	assert.match(result.content[0].text, /page says hello/);
	assert.equal(calls.length, 1);
});

test("a failed research run without a transcript is an error result, not a hang", async (t) => {
	const { calls, tools, ctx } = inlineTools(t);
	const pending = tools.get(BROWSER_AGENT).execute("call", { prompt: "read" }, undefined, undefined, ctx);
	await until(() => calls.length === 1);
	calls[0].finish(1);
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /did not complete/);
});

test("cancelling a waiting browser task stops waiting", async (t) => {
	const { calls, tools, ctx } = inlineTools(t);
	const abort = new AbortController();
	const pending = tools.get(BROWSER_AGENT).execute("call", { prompt: "read" }, abort.signal, undefined, ctx);
	await until(() => calls.length === 1);
	abort.abort();
	const result = await pending;
	assert.equal(result.isError, true);
});

test("the browser tool tells models how to name the subscription model route", () => {
	const tools = new Map();
	registerResearchTools({ on() {}, registerTool: (value) => tools.set(value.name, value), sendMessage() {} });
	const tool = tools.get(BROWSER_AGENT);
	assert.match(tool.description, /`aside` skill/);
	assert.match(JSON.stringify(tool.parameters.properties.model), /openai-codex\//);
});
