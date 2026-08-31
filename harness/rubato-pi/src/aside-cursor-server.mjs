// Aside 가 치는 localhost OpenAI 호환 면. 안쪽은 Rubato Cursor 직결.
//
// 한 프로세스가 conversation 을 들고 있어야 checkpoint echo 와 RequestContext
// pin 이 산다. 요청마다 새 프로세스를 띄우면 T2 가 다시 0% 다.

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cursorAccessToken, cursorDirectProvider } from "./cursor-route.mjs";
import { defaultTargetAuthPath } from "./credential-import.mjs";
import {
  ASIDE_CURSOR_API_KEY,
  ASIDE_CURSOR_DEFAULT_HOST,
  ASIDE_CURSOR_DEFAULT_PORT,
  asideCursorCatalog,
  conversationKey,
  openaiJsonCompletion,
  openaiSseChunk,
  openaiSseDone,
  openaiToPiContext,
  resolveCursorModel,
  usageFromStreamEvent,
} from "./aside-cursor.mjs";
import {
  ASIDE_CURSOR_LAUNCHD_LABEL,
  asideModelsUnlocked,
  defaultAsideModelsPath,
  injectXaiPriority,
  lockAsideModels,
  renderAsideCursorLaunchAgent,
  xaiUpstreamUrl,
} from "./aside-cursor-lock.mjs";

const execFileAsync = promisify(execFile);
const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
]);

export function loadCursorCredential(env = process.env) {
  const path = env.RUBATO_TARGET_AUTH_PATH ?? defaultTargetAuthPath(homedir(), env);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const credential = parsed.cursor;
  const apiKey = cursorAccessToken(credential);
  if (!apiKey) throw new Error(`aside-cursor: no cursor credential in ${path}`);
  return { path, credential, apiKey };
}

export async function createAsideCursorHandler(options = {}) {
  const credential = options.credential ?? loadCursorCredential(options.env);
  const provider = options.provider ?? await activateCursorProvider({
    ...options,
    credential: credential.credential ?? credential,
  });
  const catalog = () => (
    typeof provider.getModels === "function" ? provider.getModels() : []
  );
  const fetchImpl = options.fetch ?? fetch;
  return async function handleAsideCursor(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/xai" || url.pathname.startsWith("/xai/")) {
      await proxyXai(req, res, url, fetchImpl);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      json(res, 200, {
        object: "list",
        data: asideCursorCatalog().map((entry) => ({
          id: entry.id,
          object: "model",
          owned_by: "cursor",
        })),
      });
      return;
    }
    if (req.method !== "POST" || (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions")) {
      json(res, 404, { error: { message: "not found" } });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: { message: "invalid json" } });
      return;
    }
    const sessionId = conversationKey({ headers: req.headers, body });
    const model = resolveCursorModel(body.model, catalog());
    const context = openaiToPiContext(body);
    const completionId = `chatcmpl_rubato_${sessionId.slice(0, 8)}`;
    const streamFn = provider.streamSimple ?? provider.api?.streamSimple;
    if (typeof streamFn !== "function") throw new Error("aside-cursor: provider has no streamSimple");
    const stream = streamFn.call(provider, model, context, {
      apiKey: credential.apiKey,
      sessionId,
      headers: { "x-session-id": sessionId },
    });
    const streamed = body.stream !== false;
    try {
      if (streamed) {
        await writeSse(res, completionId, stream);
      } else {
        const { text, usage } = await collectText(stream);
        json(res, 200, openaiJsonCompletion(completionId, text, usage));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`aside-cursor ${sessionId}: ${message}`);
      if (!res.headersSent) {
        json(res, 502, { error: { message } });
        return;
      }
      res.end();
    }
  };
}

export function applyAsideModelsLock(path, options = {}) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (!asideModelsUnlocked(data, options)) return false;
  writeFileSync(path, `${JSON.stringify(lockAsideModels(data, options), null, 2)}\n`);
  return true;
}

export function watchAsideModelsLock(path, options = {}) {
  const apply = () => {
    try {
      if (applyAsideModelsLock(path, options)) {
        console.log(`aside-cursor restored Aside lock in ${path}`);
      }
    } catch (error) {
      console.error(`aside-cursor lock ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  apply();
  const timer = { id: undefined };
  const schedule = () => {
    clearTimeout(timer.id);
    timer.id = setTimeout(apply, 200);
  };
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename && filename !== basename(path)) return;
    schedule();
  });
  return () => {
    clearTimeout(timer.id);
    watcher.close();
  };
}

export async function installAsideCursorLaunchAgent(options = {}) {
  const home = options.home ?? homedir();
  const scriptPath = options.scriptPath ?? resolve(import.meta.dirname, "../../scripts/rubato-aside-cursor.sh");
  const plistPath = options.plistPath
    ?? `${home}/Library/LaunchAgents/${ASIDE_CURSOR_LAUNCHD_LABEL}.plist`;
  const stdoutPath = options.stdoutPath ?? `${home}/.rubato-pi/aside-cursor.out.log`;
  const stderrPath = options.stderrPath ?? `${home}/.rubato-pi/aside-cursor.err.log`;
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(stdoutPath), { recursive: true });
  writeFileSync(plistPath, renderAsideCursorLaunchAgent({
    scriptPath,
    stdoutPath,
    stderrPath,
    home,
  }));
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("aside-cursor launchd needs a user id");
  const domain = `gui/${uid}`;
  await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${ASIDE_CURSOR_LAUNCHD_LABEL}`]).catch(() => {});
  await execFileAsync("/bin/launchctl", ["bootstrap", domain, plistPath]);
  await execFileAsync("/bin/launchctl", ["enable", `${domain}/${ASIDE_CURSOR_LAUNCHD_LABEL}`]);
  await execFileAsync("/bin/launchctl", ["kickstart", "-k", `${domain}/${ASIDE_CURSOR_LAUNCHD_LABEL}`]);
  return { plistPath, label: ASIDE_CURSOR_LAUNCHD_LABEL };
}

export async function startAsideCursorServer(options = {}) {
  const host = options.host ?? process.env.RUBATO_ASIDE_CURSOR_HOST ?? ASIDE_CURSOR_DEFAULT_HOST;
  const port = Number(options.port ?? process.env.RUBATO_ASIDE_CURSOR_PORT ?? ASIDE_CURSOR_DEFAULT_PORT);
  const handler = options.handler ?? await createAsideCursorHandler(options);
  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) {
        json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      } else {
        res.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const bound = server.address();
  const listeningPort = typeof bound === "object" && bound ? bound.port : port;
  let stopLock;
  if (options.lock) {
    const modelsPath = options.modelsPath
      ?? process.env.RUBATO_ASIDE_MODELS_PATH
      ?? defaultAsideModelsPath(homedir());
    stopLock = watchAsideModelsLock(modelsPath, { host, port: listeningPort });
  }
  return { server, host, port: listeningPort, url: `http://${host}:${listeningPort}/v1`, stopLock };
}

async function writeSse(res, completionId, stream) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(openaiSseChunk(completionId, { role: "assistant" }));
  let usage;
  for await (const event of stream) {
    if (event?.type === "error") throw cursorStreamError(event);
    if (event?.type === "text_delta" && typeof event.delta === "string" && event.delta) {
      res.write(openaiSseChunk(completionId, { content: event.delta }));
    }
    if (event?.type === "done") {
      if (event.reason === "error") throw cursorStreamError(event);
      usage = usageFromStreamEvent(event) ?? usage;
    }
  }
  res.write(openaiSseChunk(completionId, {}, "stop", usage));
  res.write(openaiSseDone());
  res.end();
}

async function collectText(stream) {
  let text = "";
  let usage;
  for await (const event of stream) {
    if (event?.type === "error") throw cursorStreamError(event);
    if (event?.type === "text_delta" && typeof event.delta === "string") text += event.delta;
    if (event?.type === "done") {
      if (event.reason === "error") throw cursorStreamError(event);
      usage = usageFromStreamEvent(event) ?? usage;
    }
  }
  return { text, usage };
}

async function activateCursorProvider({ provider, credential, env }) {
  const cursor = provider ?? await cursorDirectProvider({ env });
  if (typeof cursor.refreshModels !== "function") return cursor;
  await cursor.refreshModels({
    credential,
    stored: { models: [] },
    allowNetwork: true,
    signal: AbortSignal.any([]),
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
  });
  return cursor;
}

function cursorStreamError(event) {
  const detail = event?.errorMessage ?? event?.reason ?? event?.error ?? "cursor stream error";
  return new Error(typeof detail === "string" ? detail : String(detail));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function proxyXai(req, res, url, fetchImpl) {
  const dest = xaiUpstreamUrl(url.pathname, url.search);
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = injectXaiPriority(await readBody(req));
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null || HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const upstream = await fetchImpl(dest, { method: req.method, headers, body });
  const out = {};
  for (const [key, value] of upstream.headers) {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== "content-encoding") {
      out[key] = value;
    }
  }
  res.writeHead(upstream.status, out);
  if (upstream.body) {
    for await (const chunk of upstream.body) res.write(chunk);
  }
  res.end();
}

const launchedAsMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (launchedAsMain) {
  if (process.argv.includes("--install")) {
    const { plistPath, label } = await installAsideCursorLaunchAgent();
    console.log(`aside-cursor launchd ${label} loaded from ${plistPath}`);
    process.exit(0);
  }
  const { host, port, url } = await startAsideCursorServer({ lock: true });
  console.log(`aside-cursor listening on ${url} (key ${ASIDE_CURSOR_API_KEY})`);
  const keep = setInterval(() => {}, 1 << 30);
  const stop = () => {
    clearInterval(keep);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  void host;
  void port;
}
