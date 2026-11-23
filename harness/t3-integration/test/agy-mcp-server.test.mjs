import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleMcpRequest, htmlToReadable, SERVER_NAME, TOOLS } from "../agy-mcp-server.mjs";

const SERVER_FILE = fileURLToPath(new URL("../agy-mcp-server.mjs", import.meta.url));

test("MCP initialize, ping, and tools/list expose the four Rubato tools", async () => {
  const init = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, SERVER_NAME);

  assert.equal(await handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.deepEqual((await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "ping" })).result, {});

  const list = await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ["memory_search", "webfetch", "web_agent", "deep_research"],
  );
  assert.equal(TOOLS.length, 4);
});

test("memory_search calls msearch with scope flags and returns its output", async () => {
  const calls = [];
  const res = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "memory_search", arguments: { query: "agy acp", scope: "user" } },
    },
    {
      env: { RUBATO_MSEARCH_CLI: "/fake/msearch" },
      cwd: () => "/work",
      execFile: async (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts.cwd });
        return { stdout: "matched note\n", stderr: "" };
      },
    },
  );
  assert.equal(res.result.isError, undefined);
  assert.equal(res.result.content[0].text, "matched note");
  assert.deepEqual(calls, [{ cmd: "/fake/msearch", args: ["-u", "--", "agy acp"], cwd: "/work" }]);
});

test("webfetch converts HTML to readable markdown and rejects non-HTTP URLs", async () => {
  const bad = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "webfetch", arguments: { url: "file:///etc/passwd" } },
  });
  assert.equal(bad.result.isError, true);

  const ok = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "webfetch", arguments: { url: "https://example.com/doc" } },
    },
    {
      fetch: async () => new Response("<h1>Title</h1><p>Hello <a href='https://a.test'>world</a> &amp; more</p>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    },
  );
  assert.equal(ok.result.isError, undefined);
  assert.match(ok.result.content[0].text, /# Title/);
  assert.match(ok.result.content[0].text, /\[world\]\(https:\/\/a\.test\) & more/);
  assert.equal(htmlToReadable("<script>x()</script><p>ok</p>", "text"), "ok");
});

test("web_agent invokes aside exec and blocks unavailable models", async () => {
  const blocked = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "web_agent", arguments: { prompt: "check", model: "openai/gpt-5.6-sol" } },
  });
  assert.equal(blocked.result.isError, true);

  const calls = [];
  const ok = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "web_agent", arguments: { prompt: "find docs", effort: "high" } },
    },
    {
      findExecutable: async (name) => (name === "aside" ? "/fake/aside" : null),
      execFile: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: JSON.stringify({ sessionId: "s1", answer: "Found it." }), stderr: "" };
      },
    },
  );
  assert.equal(ok.result.isError, undefined);
  assert.match(ok.result.content[0].text, /Aside session: s1/);
  assert.match(ok.result.content[0].text, /Found it\./);
  assert.deepEqual(calls, [{
    cmd: "/fake/aside",
    args: ["exec", "--json", "--timeout=45m", "--effort=high", "--", "find docs"],
  }]);
});

test("deep_research writes packet.md, calls outpost send, and reads response.md", async () => {
  const calls = [];
  const ok = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "deep_research", arguments: { question: "Compare A vs B", quality: "xhigh" } },
    },
    {
      findExecutable: async (name) => (name === "outpost" ? "/fake/outpost" : null),
      execFile: async (cmd, args) => {
        calls.push({ cmd, args });
        const runArg = args.find((a) => a.startsWith("--run="));
        const runDir = runArg.slice("--run=".length);
        const packetPath = args.at(-1);
        const packetText = await readFile(packetPath, "utf8");
        assert.match(packetText, /Compare A vs B/);
        await writeFile(path.join(runDir, "response.md"), "Final synthesis from Pro.");
        return { stdout: "ok", stderr: "" };
      },
    },
  );
  assert.equal(ok.result.isError, undefined);
  assert.match(ok.result.content[0].text, /Final synthesis from Pro\./);
  assert.equal(calls[0].cmd, "/fake/outpost");
  assert.ok(calls[0].args.includes("--quality=xhigh"));
});

test("stdio server speaks both newline-delimited JSON and Content-Length framing", async () => {
  const child = spawn(process.execPath, [SERVER_FILE, "--legacy-four-tools"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const out = [];
    child.stdout.on("data", (chunk) => out.push(chunk.toString("utf8")));

    const req1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    child.stdin.write(`${req1}\n`);

    const req2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(req2, "utf8")}\r\n\r\n${req2}`);
    child.stdin.end();

    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0);

    const combined = out.join("");
    assert.match(combined, /"serverInfo":\{"name":"rubato-tools"/);
    assert.match(combined, /Content-Length: \d+\r\n\r\n.*"memory_search"/);
  } finally {
    child.kill();
  }
});
