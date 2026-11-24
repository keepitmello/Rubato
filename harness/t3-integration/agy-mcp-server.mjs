#!/usr/bin/env node
// Standalone stdio MCP server exposing Rubato's user-facing tools to official `agy`.
// Zero third-party dependencies so `agy` can launch it with plain Node from any checkout.
//
// Tools:
//   - memory_search : search Rubato project/user memory via `msearch`
//   - webfetch      : fetch a URL as markdown, text, or HTML
//   - browser_agent : run a browser/research task through Aside (`aside exec`)
//   - deep_research : submit a ChatGPT Pro research run through Outpost (`outpost send`)
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SERVER_NAME = "rubato-tools";
export const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const MAX_TOOL_TEXT_CHARS = 24_000;
const BLOCKED_ASIDE_MODELS = new Set(["openai/gpt-5.6-sol", "cursor/gpt-5.6-sol"]);
const REPO_MSEARCH_SCRIPT = fileURLToPath(new URL("../msearch/memory-search.py", import.meta.url));

export const TOOLS = Object.freeze([
  {
    name: "memory_search",
    description:
      "Search Rubato project and user memory via msearch. Query in English with short anchors (a component, error, or decision).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query in English with short anchors.",
        },
        scope: {
          type: "string",
          enum: ["project", "user", "all"],
          description: "project (default), user, or all.",
        },
        cwd: {
          type: "string",
          description: "Optional project directory for project-scoped memory.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "webfetch",
    description: "Fetch a specific HTTP/HTTPS URL and return its content as markdown, plain text, or raw HTML.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http:// or https:// URL to fetch." },
        format: {
          type: "string",
          enum: ["markdown", "text", "html"],
          description: "Output format (default: markdown).",
        },
        timeout: {
          type: "number",
          description: "Optional timeout in seconds (1..120, default: 30).",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_agent",
    description:
      "Delegate a browser or broad fresh web research task to Aside Browser (`aside exec`). Request source links, dates, and quotations when collecting evidence.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The browser or research task for Aside." },
        account: { type: "string", description: "Optional Aside account (e.g. u0, u1)." },
        profile: { type: "string", description: "Optional Aside browser profile ID." },
        host: { type: "string", description: "Optional Aside host ID or name." },
        model: { type: "string", description: "Optional exact configured provider/model ID." },
        effort: {
          type: "string",
          enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultrabrowse"],
          description: "Optional thinking effort.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "deep_research",
    description:
      "Ask ChatGPT Pro via Outpost (`outpost send`) for deep research, independent judgment, synthesis, or diagnosis.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The research question, context, and constraints." },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Optional file paths to package and attach.",
        },
        thread: { type: "string", description: "Optional Outpost thread ID or ChatGPT conversation URL." },
        quality: {
          type: "string",
          enum: ["pro", "xhigh"],
          description: "Outpost quality tier (default: pro).",
        },
        artifact: { type: "boolean", description: "Save a generated ZIP artifact alongside the response." },
        cwd: { type: "string", description: "Optional base directory for relative attachment paths." },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
]);

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text, max = MAX_TOOL_TEXT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (truncated ${text.length - max} chars)`;
}

function toolResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function findExecutable(name, env = process.env, platform = process.platform) {
  const windows = platform === "win32";
  const pathValue = windows
    ? Object.entries(env).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
    : env.PATH;
  const isAbsolute = windows ? path.win32.isAbsolute : path.posix.isAbsolute;
  const dirs = (pathValue ?? "").split(windows ? ";" : ":").filter((entry) => isAbsolute(entry));
  const home = env.HOME || (windows ? env.USERPROFILE : undefined) || homedir();
  if (home) dirs.push(path.join(home, ".local", "bin"));
  const names = windows ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of dirs) {
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName);
      try {
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* next */ }
    }
  }
  return null;
}

function decodeHtmlEntities(text) {
  const named = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const lower = entity.toLowerCase();
    if (named[lower]) return named[lower];
    if (lower.startsWith("&#x")) {
      const code = Number.parseInt(lower.slice(3, -1), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    if (lower.startsWith("&#")) {
      const code = Number.parseInt(lower.slice(2, -1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return entity;
  });
}

export function htmlToReadable(html, format = "markdown") {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");

  if (format === "markdown") {
    text = text
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, body) => `\n\n${"#".repeat(Number(level))} ${body.trim()}\n\n`)
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, body) => `[${body.trim()}](${href})`)
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => `\n- ${body.trim()}`)
      .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body) => `\n\n\`\`\`\n${body}\n\`\`\`\n\n`)
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, body) => `\`${body}\``);
  }

  text = text
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|footer|main|aside|tr|blockquote|ul|ol|table)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function runMemorySearch(args, deps) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return toolResult("memory_search: query is required", true);
  const scope = args.scope === "user" || args.scope === "all" ? args.scope : "project";
  const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : deps.cwd();
  const flag = scope === "user" ? ["-u"] : scope === "all" ? ["-a"] : [];

  const envCli = deps.env.RUBATO_MSEARCH_CLI?.trim();
  let command = envCli || (await deps.findExecutable("msearch", deps.env));
  let cliArgs = [...flag, "--", query];

  if (!command) {
    try {
      await access(REPO_MSEARCH_SCRIPT, constants.R_OK);
      command = "python3";
      cliArgs = [REPO_MSEARCH_SCRIPT, ...cliArgs];
    } catch {
      return toolResult("memory_search: msearch CLI is not installed on PATH or ~/.local/bin.", true);
    }
  }

  try {
    const { stdout, stderr } = await deps.execFile(command, cliArgs, {
      cwd,
      env: deps.env,
      timeout: 120_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return toolResult(combined ? truncate(combined) : "NO RELEVANT MEMORY");
  } catch (error) {
    const output = [error.stdout?.trim?.(), error.stderr?.trim?.()].filter(Boolean).join("\n");
    return toolResult(
      truncate([`memory_search failed: ${error.message}`, output].filter(Boolean).join("\n")),
      true,
    );
  }
}

async function runWebfetch(args, deps) {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return toolResult("webfetch: URL must start with http:// or https://", true);
  try { new URL(url); } catch { return toolResult(`webfetch: invalid URL: ${url}`, true); }
  const format = args.format === "text" || args.format === "html" ? args.format : "markdown";
  const timeoutSec = Number.isFinite(args.timeout) && args.timeout > 0 ? Math.min(Math.ceil(args.timeout), 120) : 30;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutSec}s`)), timeoutSec * 1000);
  try {
    const response = await deps.fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: format === "html" ? "text/html, */*;q=0.1" : "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) return toolResult(`webfetch: HTTP ${response.status} ${response.statusText}`, true);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_FETCH_BYTES) {
      return toolResult(`webfetch: response exceeded ${MAX_FETCH_BYTES} bytes`, true);
    }
    const raw = buffer.toString("utf8");
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (format === "html" || (!contentType.includes("html") && !raw.trimStart().startsWith("<"))) {
      return toolResult(truncate(raw));
    }
    return toolResult(truncate(htmlToReadable(raw, format)));
  } catch (error) {
    return toolResult(`webfetch failed: ${error.message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

async function runBrowserAgent(args, deps) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return toolResult("browser_agent: prompt is required", true);
  if (typeof args.model === "string" && BLOCKED_ASIDE_MODELS.has(args.model)) {
    return toolResult("browser_agent: that model is not available on the configured Aside account.", true);
  }
  const aside = await deps.findExecutable("aside", deps.env);
  if (!aside) return toolResult("browser_agent: `aside` CLI was not found on PATH or ~/.local/bin.", true);

  const opt = (name, value) => (typeof value === "string" && value.trim() ? [`--${name}=${value.trim()}`] : []);
  const cliArgs = [
    "exec",
    "--json",
    "--timeout=45m",
    ...opt("account", args.account),
    ...opt("host", args.host),
    ...opt("profile", args.profile),
    ...opt("effort", args.effort),
    ...opt("model", args.model),
    "--",
    prompt,
  ];
  try {
    const { stdout, stderr } = await deps.execFile(aside, cliArgs, {
      cwd: deps.cwd(),
      env: deps.env,
      timeout: 46 * 60_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    let parsed;
    try { parsed = JSON.parse(stdout.trim()); } catch { parsed = null; }
    if (parsed && typeof parsed === "object") {
      const answer = typeof parsed.answer === "string" ? parsed.answer : typeof parsed.result === "string" ? parsed.result : "";
      const session = typeof parsed.sessionId === "string" ? `Aside session: ${parsed.sessionId}\n\n` : "";
      if (answer) return toolResult(truncate(`${session}${answer}`));
    }
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return toolResult(truncate(combined || "browser_agent completed with empty output."));
  } catch (error) {
    const output = [error.stdout?.trim?.(), error.stderr?.trim?.()].filter(Boolean).join("\n");
    return toolResult(truncate([`browser_agent failed: ${error.message}`, output].filter(Boolean).join("\n")), true);
  }
}

async function runDeepResearch(args, deps) {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) return toolResult("deep_research: question is required", true);
  const outpost = await deps.findExecutable("outpost", deps.env);
  if (!outpost) return toolResult("deep_research: `outpost` CLI was not found on PATH or ~/.local/bin.", true);

  const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : deps.cwd();
  const quality = args.quality === "xhigh" ? "xhigh" : "pro";
  const runDir = await mkdtemp(path.join(tmpdir(), "rubato-agy-outpost-"));
  const packet = path.join(runDir, "packet.md");
  const subject = Array.from(question.split(/\r?\n/, 1)[0].replace(/^#+\s*/, "").trim()).slice(0, 100).join("") || "Research question";
  await writeFile(packet, `# ${subject}\n\n${question}\n`, { mode: 0o600 });

  const attachArgs = [];
  const rawAttachments = Array.isArray(args.attachments) ? args.attachments.filter((item) => typeof item === "string" && item.trim()) : [];
  if (rawAttachments.length > 0) {
    const resolved = [];
    for (const item of rawAttachments) {
      const full = await realpath(path.resolve(cwd, item));
      const info = await stat(full);
      if (!info.isFile()) return toolResult(`deep_research: not a regular file: ${item}`, true);
      resolved.push(full);
    }
    const archive = path.join(runDir, "evidence.zip");
    if (resolved.length === 1 && /\.zip$/i.test(resolved[0])) {
      await copyFile(resolved[0], archive);
    } else {
      const staging = path.join(runDir, "evidence-input");
      await mkdir(staging, { mode: 0o700 });
      const names = [];
      for (const [index, source] of resolved.entries()) {
        const name = `${index + 1}-${path.basename(source)}`;
        await copyFile(source, path.join(staging, name));
        names.push(name);
      }
      try {
        await deps.execFile("zip", ["-q", archive, "--", ...names], { cwd: staging, timeout: 60_000 });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    attachArgs.push(`--attach=${archive}`);
  }

  const cliArgs = [
    "send",
    `--quality=${quality}`,
    `--run=${runDir}`,
    ...(typeof args.thread === "string" && args.thread.trim() ? [`--to=${args.thread.trim()}`] : []),
    ...(args.artifact ? [`--artifact=${path.join(runDir, "artifact.zip")}`] : []),
    ...attachArgs,
    "--",
    packet,
  ];
  const env = { ...deps.env };
  delete env.OUTPOST_FORCE;

  try {
    const { stdout, stderr } = await deps.execFile(outpost, cliArgs, {
      cwd,
      env,
      timeout: 45 * 60_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    const responsePath = path.join(runDir, "response.md");
    let responseBody = "";
    try { responseBody = await readFile(responsePath, "utf8"); } catch { /* fall back to stdout */ }
    const receiptPath = path.join(runDir, "receipt.json");
    const header = `Run dir: ${runDir}\nReceipt: ${receiptPath}`;
    const body = responseBody.trim() || [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return toolResult(truncate(`${header}\n\n${body}`));
  } catch (error) {
    const output = [error.stdout?.trim?.(), error.stderr?.trim?.()].filter(Boolean).join("\n");
    return toolResult(
      truncate([`deep_research failed (run dir: ${runDir}): ${error.message}`, output].filter(Boolean).join("\n")),
      true,
    );
  }
}

export async function runTool(name, args = {}, overrides = {}) {
  const deps = {
    env: process.env,
    cwd: () => process.cwd(),
    execFile: execFileAsync,
    fetch: globalThis.fetch,
    findExecutable,
    ...overrides,
  };
  if (name === "memory_search") return runMemorySearch(args, deps);
  if (name === "webfetch") return runWebfetch(args, deps);
  if (name === "browser_agent") return runBrowserAgent(args, deps);
  if (name === "deep_research") return runDeepResearch(args, deps);
  return toolResult(`Unknown ${SERVER_NAME} tool: ${name}`, true);
}

function successResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleMcpRequest(input, overrides = {}) {
  if (!isPlainRecord(input)) return errorResponse(null, -32600, "Invalid Request");
  const id = typeof input.id === "string" || typeof input.id === "number" ? input.id : null;
  const method = typeof input.method === "string" ? input.method : null;

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return undefined;
  }
  if (method === "ping") return successResponse(id, {});
  if (method === "initialize") {
    const requestedVersion = isPlainRecord(input.params) && typeof input.params.protocolVersion === "string"
      ? input.params.protocolVersion
      : DEFAULT_PROTOCOL_VERSION;
    return successResponse(id, {
      protocolVersion: requestedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "tools/list") return successResponse(id, { tools: await overrides.sessionTools?.list() ?? TOOLS });
  if (method === "tools/call") {
    const params = isPlainRecord(input.params) ? input.params : {};
    const name = typeof params.name === "string" ? params.name : "";
    if (overrides.sessionTools) {
      return successResponse(id, await overrides.sessionTools.call(name, params.arguments, { signal: overrides.signal }));
    }
    const args = isPlainRecord(params.arguments) ? params.arguments : {};
    return successResponse(id, await runTool(name, args, overrides));
  }
  if (id === null) return undefined;
  return errorResponse(id, -32601, `Method not found: ${method ?? "(missing)"}`);
}

function writeResponse(output, response, mode) {
  const body = JSON.stringify(response);
  const payload = mode === "framed"
    ? `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
    : `${body}\n`;
  output.write(payload);
}

export async function runStdioServer(input = process.stdin, output = process.stdout, overrides = {}, handleRequest = handleMcpRequest) {
  let buffer = Buffer.alloc(0);
  const HEADER_SEP = Buffer.from("\r\n\r\n");
  let clientForms = false;
  let mode = "line";
  let nextOutgoing = 0;
  let queue = Promise.resolve();
  let disconnected = false;
  const pending = new Map();
  const running = new Map();
  overrides.elicit = (message, requestedSchema, signal) => {
    if (!clientForms || disconnected || signal?.aborted) return Promise.resolve(undefined);
    const id = `rubato-form-${++nextOutgoing}`;
    return new Promise(resolve => {
      const finish = value => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        resolve(value);
      };
      const cancel = () => {
        if (!disconnected && pending.has(id))
          writeResponse(output, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }, mode);
        finish(undefined);
      };
      const timer = setTimeout(cancel, 120_000);
      pending.set(id, finish);
      signal?.addEventListener("abort", cancel, { once: true });
      writeResponse(output, { jsonrpc: "2.0", id, method: "elicitation/create",
        params: { mode: "form", message, requestedSchema } }, mode);
    });
  };

  const nextFrame = () => {
    if (buffer.length === 0) return null;
    if (/^Content-Length:/i.test(buffer.subarray(0, 32).toString("utf8"))) {
      const sep = buffer.indexOf(HEADER_SEP);
      if (sep === -1) return null;
      const headers = buffer.subarray(0, sep).toString("utf8");
      const match = /^Content-Length:\s*(\d+)/im.exec(headers);
      if (!match) {
        buffer = buffer.subarray(sep + HEADER_SEP.length);
        return { mode: "framed", parseError: "Missing Content-Length" };
      }
      const length = Number(match[1]);
      const start = sep + HEADER_SEP.length;
      if (buffer.length < start + length) return null;
      const raw = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      try { return { mode: "framed", payload: JSON.parse(raw) }; }
      catch { return { mode: "framed", parseError: "Parse error" }; }
    }
    const nl = buffer.indexOf(0x0a);
    if (nl === -1) return null;
    const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
    buffer = buffer.subarray(nl + 1);
    if (!line) return { skip: true };
    try { return { mode: "line", payload: JSON.parse(line) }; }
    catch { return { mode: "line", parseError: "Parse error" }; }
  };

  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const frame = nextFrame();
      if (!frame) break;
      if (frame.skip) continue;
      if (frame.parseError) {
        writeResponse(output, errorResponse(null, -32700, frame.parseError), frame.mode);
        continue;
      }
      const payload = frame.payload;
      if (payload?.method === "initialize") {
        const options = payload.params?.capabilities?.elicitation;
        clientForms = isPlainRecord(options) && (isPlainRecord(options.form) || !Object.keys(options).length);
        mode = frame.mode;
      }
      if (payload?.method === "notifications/cancelled") {
        running.get(payload.params?.requestId)?.abort();
        pending.get(payload.params?.requestId)?.();
        continue;
      }
      if (isPlainRecord(payload) && !payload.method && ("result" in payload || "error" in payload)) {
        pending.get(payload.id)?.(payload.result);
        continue;
      }
      const isTool = payload?.method === "tools/call";
      const call = isTool ? new AbortController() : undefined;
      if (call) running.set(payload?.id, call);
      queue = queue.then(async () => {
        try {
          if (call?.signal.aborted) return;
          const response = await handleRequest(payload, { ...overrides, signal: call?.signal });
          if (response !== undefined && !call?.signal.aborted) writeResponse(output, response, frame.mode);
        } catch (error) {
          if (!call?.signal.aborted) writeResponse(output, errorResponse(payload?.id ?? null, -32603, error.message), frame.mode);
        } finally { if (call) running.delete(payload?.id); }
      });
    }
  }
  disconnected = true;
  for (const finish of pending.values()) finish(undefined);
  await queue;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const writeProtocol = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  const overrides = {};
  let opened;
  if (!process.argv.includes("--legacy-four-tools")) {
    // Start lazily after MCP initialize so a cold Rubato runtime cannot time out the handshake.
    const url = process.env.RUBATO_AGY_APPROVAL_URL;
    const token = process.env.RUBATO_AGY_APPROVAL_TOKEN;
    const native = () => opened ??= import("./agy-native-tools.mjs").then(({ openAgyNativeTools }) =>
      openAgyNativeTools({ elicit: url && token && /^http:\/\/127\.0\.0\.1:\d+\/form$/.test(url)
        ? async (message, requestedSchema, signal) => {
            const response = await fetch(url, { method: "POST", redirect: "error", signal,
              headers: { authorization: token, "content-type": "application/json" },
              body: JSON.stringify({ message, requestedSchema }) }).catch(() => undefined);
            return response?.ok ? await response.json() : undefined;
          }
        : overrides.elicit }));
    overrides.sessionTools = { list: async () => (await native()).list(),
      call: async (name, args, options) => (await native()).call(name, args, options) };
  }
  runStdioServer(process.stdin, { write: writeProtocol }, overrides).catch((error) => {
    process.stderr.write(`${SERVER_NAME}: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }).finally(async () => { if (opened) await (await opened.catch(() => undefined))?.close(); })
    .catch(error => { process.stderr.write(`${SERVER_NAME}: ${error.message}\n`); process.exitCode = 1; });
}
