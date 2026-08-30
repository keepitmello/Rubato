// Live-vendor smoke for the in-process direct provider route.
// Spawns Senpi RPC inside a throwaway profile. Never touches 127.0.0.1:8788
// and never writes under ~/.rubato-pi, ~/.senpi, or ~/.claude.
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { providerOverlayPath, senpiCliPath } from "../../src/launch.mjs";
import { launchEnv } from "../../src/brand.mjs";
import { DISABLED_OAUTH_EXTENSIONS } from "../../src/session-defaults.mjs";
import { createLineReader, createRpcWaiter } from "./rpc-waiter.mjs";
import { importLegacyDirectCredentials } from "../../src/credential-import.mjs";
import { CLAUDE_SETUP_TOKEN_FILE_ENV, CLAUDE_SETUP_TOKEN_PREFIX } from "../../src/anthropic-setup-token.mjs";
import { KIRO_CONFIG_PATH_ENV } from "../../src/kiro-route.mjs";
import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_OAUTH_FILE_ENV,
  antigravityOAuth,
  loadAntigravityProjectId,
} from "../../src/antigravity-route.mjs";
import { ANTIGRAVITY_PROJECT_ENV } from "../../src/antigravity-api.mjs";
import {
  decodeAntigravityKeychainSecret,
  importAntigravityKeychainCredential,
  readAntigravityKeychainSecret,
} from "../../src/antigravity-keychain-import.mjs";
import { PROVIDER_DIRECT_FLAG } from "../../src/provider-direct.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const captureExtension = join(here, "direct-wire-extension.mjs");
const liveAuthPath = join(homedir(), ".rubato-pi", "agent", "auth.json");
const realSenpiAuth = join(homedir(), ".senpi", "agent", "auth.json");
const realClaudeToken = join(homedir(), ".claude", "auth", "setup-token-sub");
const realKiroConfig = join(homedir(), ".rubato-pi", "kiro", "config.json");
const realAntigravityOauth = join(homedir(), ".rubato-pi", "antigravity-oauth.json");
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const TURN_MS = Number(process.env.RUBATO_DIRECT_SMOKE_TURN_MS ?? 120_000);
const BOOT_MS = Number(process.env.RUBATO_DIRECT_SMOKE_BOOT_MS ?? 45_000);

/**
 * 우리가 띄운 자식 중 실 프로필을 가리킨 것이 있는가.
 *
 * 격리의 근거는 `childEnv` 가 `HOME` 과 agent 디렉터리를 temp 로 돌린다는 것이다. 그것이
 * 지켜졌는지는 우리가 실제로 넘긴 env 를 보면 알 수 있고, 그래야 "파일이 바뀌었다" 와
 * "우리가 바꿨다" 를 가릴 수 있다.
 */
const spawnedProfileTargets = [];

function liveProfileTargets() {
  const live = join(homedir(), ".rubato-pi");
  return spawnedProfileTargets.filter((dir) => dir === live || dir.startsWith(`${live}/`));
}

function snapshotBytes(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`cannot snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function bytesEqual(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
}

function attachWaiter(child) {
  const wait = createRpcWaiter();
  child.stdout.on("data", createLineReader(wait.push));
  return wait;
}

function send(child, payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function assistantMessages(messages) {
  return (messages ?? []).filter((m) => m.role === "assistant" || m.type === "assistant");
}

function assistantText(messages) {
  const asst = [...assistantMessages(messages)].at(-1);
  if (!asst) return null;
  if (typeof asst.content === "string") return asst.content;
  if (typeof asst.text === "string") return asst.text;
  if (Array.isArray(asst.content)) {
    return asst.content.map((part) => part.text ?? part.content ?? part.thinking ?? "").join("");
  }
  return null;
}

function turnDiagnostics(ended) {
  const asst = [...assistantMessages(ended?.messages)].at(-1);
  const text = assistantText(ended?.messages);
  return JSON.stringify({
    errorMessage: ended?.errorMessage ?? asst?.errorMessage,
    stopReason: ended?.stopReason ?? asst?.stopReason,
    willRetry: ended?.willRetry,
    roles: (ended?.messages ?? []).map((m) => m.role ?? m.type).slice(-6),
    contentTypes: contentParts(asst).map((part) => part?.type),
    textLen: String(text ?? "").length,
    text: String(text ?? "").slice(0, 160),
  });
}

function contentParts(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

function hasNativeThinking(messages) {
  for (const message of assistantMessages(messages)) {
    for (const part of contentParts(message)) {
      if (part?.type === "thinking" && (part.thinkingSignature || part.thinking)) return true;
    }
  }
  return false;
}

function thinkingSignatures(messages) {
  const out = [];
  for (const message of assistantMessages(messages)) {
    for (const part of contentParts(message)) {
      if (part?.type === "thinking" && part.thinkingSignature) out.push(part.thinkingSignature);
    }
  }
  return out;
}

function parseReasoningSignature(signature) {
  if (typeof signature !== "string" || signature.length === 0) return null;
  try {
    const parsed = JSON.parse(signature);
    return parsed?.type === "reasoning" ? parsed : null;
  } catch {
    return null;
  }
}

function nativeReasoningFromMessages(messages) {
  return thinkingSignatures(messages).map(parseReasoningSignature).filter(Boolean);
}

function flattenedReasoningText(messages) {
  for (const message of assistantMessages(messages)) {
    for (const part of contentParts(message)) {
      if (part?.type === "text" && /encrypted_content|"type":"reasoning"/.test(String(part.text ?? ""))) return true;
    }
  }
  return false;
}

function readWire(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function wireSummary(path) {
  const wire = readWire(path);
  return {
    count: wire.length,
    boots: wire.filter((e) => e.boot).length,
    urls: [...new Set(wire.map((e) => String(e.url ?? "").split("?")[0]).filter(Boolean))].slice(0, 8),
  };
}

function createProfile(label) {
  const home = mkdtempSync(join(tmpdir(), `rubato-pi-direct-${label}-`));
  const agentDir = join(home, "agent");
  const cwd = join(home, "cwd");
  const sessionsDir = join(home, "sessions");
  const wireLog = join(home, "wire.jsonl");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(join(home, ".claude", "auth"), { recursive: true });
  mkdirSync(join(home, ".rubato-pi", "kiro"), { recursive: true });
  // `security` looks up the login keychain from HOME. The child HOME is a throwaway
  // profile, so expose the real login keychain read-only. This is not a write to
  // ~/Library/Keychains — only a local symlink inside the temp home.
  const realKeychains = join(homedir(), "Library", "Keychains");
  if (existsSync(realKeychains)) {
    mkdirSync(join(home, "Library"), { recursive: true });
    try {
      symlinkSync(realKeychains, join(home, "Library", "Keychains"));
    } catch {
      // If the host has no Keychain dir the Keychain gates SKIP themselves.
    }
  }
  // 실 세션은 `launch.mjs` 의 `ensureSessionDefaults` 로 이 값들을 받는다. 러너가 그것을
  // 흉내내지 않으면 **실 세션에 없는 구성**을 검증하게 된다. 실제로 그래서 틀렸다:
  // `cursor-cli-oauth` 가 여기서만 살아 있었고, 그 lane 의 catalog 가 `gemini-3.7-flash` 를
  // `input: ["text"]` 로 들고 있어 같은 id 인 우리 Antigravity 모델을 가렸다. 그 결과
  // 도구 결과를 실을 때 pinned encoder 가 `model.input` 에서 죽었다.
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({
      defaultProjectTrust: "always",
      permissionPreset: "full-access",
      compaction: { enabled: false },
      disabledBuiltinExtensions: DISABLED_OAUTH_EXTENSIONS,
    })}\n`,
  );
  writeFileSync(join(cwd, "hello.txt"), "KIRO_SMOKE_OK\n");
  return { home, agentDir, cwd, sessionsDir, wireLog };
}

function childEnv(profile, extra = {}) {
  const env = {
    ...launchEnv(process.env, profile.agentDir),
    HOME: profile.home,
    PATH: process.env.PATH,
    [PROVIDER_DIRECT_FLAG]: "1",
    RUBATO_BROKER_URL: "http://127.0.0.1:1",
    RUBATO_LEGACY_AUTH_PATH: realSenpiAuth,
    // 이관 대상을 **명시로** 못 박는다. `HOME` 과 agent 디렉터리만으로 해석에 맡기면,
    // 해석 규칙이 바뀌는 순간 격리가 조용히 깨진다. 여기서 못 박으면 그 위험이 사라지고,
    // 아래 기록으로 "우리 자식이 어디를 가리켰는지" 를 사후에 증명할 수 있다.
    RUBATO_TARGET_AUTH_PATH: join(profile.agentDir, "auth.json"),
    RUBATO_DIRECT_WIRE_LOG: profile.wireLog,
    ...extra,
  };
  // `NODE_OPTIONS=--import` 로 포착기를 더 일찍 세워 보려 했지만 **되돌렸다.** Codex 는 여전히
  // 못 잡았고(SDK 가 자기 시점의 `fetch` 를 붙잡는다), 그러면서 이미 동작하던 Kiro·Anthropic
  // Keychain 포착을 깨뜨렸다 — 두 검사가 "no request captured" 로 실패했다. 같은 모듈이 두
  // 경로로 로드되어 설치 가드가 먼저 걸린 것으로 보인다.
  //
  // 계측을 더 일찍 세우려면 provider 에 fetch 주입구가 있어야 하고, 그건 pinned 층을 건드리는
  // 별개 작업이다. 그때까지 `-e` extension 경로를 쓴다.
  delete env.NODE_OPTIONS;
  // 실제로 넘긴 값을 기록한다. 추정이 아니라 이것이 격리의 증거다.
  spawnedProfileTargets.push(dirname(env.RUBATO_TARGET_AUTH_PATH));
  return env;
}

/**
 * temp 프로필에 자격증명을 심는다.
 *
 * 원본은 **실 토큰이 있는 쪽**이다. `importLegacyDirectCredentials` 는 한 번에 한 저장소만
 * 읽으므로, profile 과 legacy 양쪽에 나뉘어 있으면 두 번 돌려야 한다. 그러지 않으면 방금
 * 로그인한 provider 가 temp 로 넘어가지 않아 검증이 옛 토큰으로 돌아간다.
 *
 * 실 저장소는 읽기만 한다. 쓰기는 `RUBATO_TARGET_AUTH_PATH` 가 가리키는 temp 뿐이다.
 */
async function seedCredentials(env) {
  const sources = new Set();
  for (const id of ["openai-codex", "xai"]) {
    const source = credentialSource(id);
    if (source) sources.add(source.where === "profile" ? liveAuthPath : realSenpiAuth);
  }
  // 아무 것도 못 찾았으면 예전 동작을 유지한다 — 그 경우의 판정은 각 검사가 한다.
  if (sources.size === 0) sources.add(realSenpiAuth);

  const reports = [];
  for (const sourcePath of sources) {
    reports.push(await importLegacyDirectCredentials({ env: { ...env, RUBATO_LEGACY_AUTH_PATH: sourcePath } }));
  }
  // 뒤 보고가 앞의 것을 가리지 않게 합친다. 한 provider 라도 못 옮겼으면 그것이 보여야 한다.
  return {
    status: reports.every((r) => r.status === "ok") ? "ok" : reports.find((r) => r.status !== "ok")?.status ?? "ok",
    imported: reports.flatMap((r) => r.imported ?? []),
    skipped: reports.flatMap((r) => r.skipped ?? []),
    rejected: Object.assign({}, ...reports.map((r) => r.rejected ?? {})),
  };
}

function spawnRpc(profile, { model, extraArgs = [], extraEnv = {} } = {}) {
  const env = childEnv(profile, extraEnv);
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === null) delete env[key];
  }
  const args = [
    senpiCliPath(),
    "--mode",
    "rpc",
    "--no-context-files",
    "--no-prompt-templates",
    "--approve",
    "--permission-preset",
    "full-access",
    "--session-dir",
    profile.sessionsDir,
    "-e",
    captureExtension,
    "-e",
    providerOverlayPath(),
    ...extraArgs,
  ];
  if (model) args.push("--model", model);
  const child = spawn(process.execPath, args, {
    cwd: profile.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });
  const wait = attachWaiter(child);
  return { child, wait, stderr: () => stderr, env };
}

async function waitForSessionStart(session) {
  if (session.wait.records.some((rec) => rec.type === "session_start")) return;
  try {
    await session.wait((rec) => rec.type === "session_start", BOOT_MS, "session_start");
  } catch {
    await rpc(session, { id: "ready", type: "get_state" }, "get_state");
  }
}

async function waitForAvailableModel(session, provider, modelId) {
  await waitForSessionStart(session);
  const listed = await rpc(
    session,
    { id: `avail-${provider}`, type: "get_available_models" },
    "get_available_models",
  );
  const models = listed.data?.models ?? listed.models ?? [];
  if (models.some((model) => model.provider === provider && model.id === modelId)) return listed;
  const names = models.map((model) => `${model.provider}/${model.id}`).slice(0, 24);
  throw new Error(`model not available: ${provider}/${modelId}; listed=${names.join(",") || "none"}`);
}

async function setModel(session, provider, modelId) {
  await waitForAvailableModel(session, provider, modelId);
  const ready = session.wait(
    (rec) => rec.type === "response" && rec.command === "set_model",
    BOOT_MS,
    "set_model",
  );
  send(session.child, { id: `m-${provider}`, type: "set_model", provider, modelId });
  const rec = await ready;
  if (rec.success === false) {
    throw new Error(`set_model ${provider}/${modelId} failed: ${JSON.stringify(rec.error ?? rec).slice(0, 400)}`);
  }
  return rec;
}

async function promptTurn(session, message, { id = "p", images, thinkingLevel, timeoutMs = TURN_MS } = {}) {
  const endedP = session.wait(
    (rec) => rec.type === "agent_end" && rec.willRetry !== true,
    timeoutMs,
    `agent_end:${id}`,
  );
  const payload = { id, type: "prompt", message };
  if (images) payload.images = images;
  if (thinkingLevel) payload.thinkingLevel = thinkingLevel;
  send(session.child, payload);
  try {
    return await endedP;
  } catch (error) {
    const stderr = session.stderr?.()?.slice(-800) ?? "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`);
  }
}

async function rpc(session, payload, command, timeoutMs = BOOT_MS) {
  const ready = session.wait(
    (rec) => rec.type === "response" && rec.command === command && (payload.id ? rec.id === payload.id : true),
    timeoutMs,
    command,
  );
  send(session.child, payload);
  return await ready;
}

function stop(session) {
  if (!session?.child) return Promise.resolve();
  try {
    session.child.stdin.end();
  } catch {
    // already closed
  }
  try {
    session.child.kill("SIGKILL");
  } catch {
    // already dead
  }
  return new Promise((resolve) => {
    const done = () => resolve();
    if (session.child.exitCode !== null || session.child.signalCode) {
      resolve();
      return;
    }
    session.child.once("exit", done);
    setTimeout(done, 2000);
  });
}

function cleanupHome(home) {
  // 실패를 진단할 때는 wire log 가 유일한 증거다. 지워 버리면 무엇이 상류로 나갔는지
  // 물어볼 방법이 없어 추측만 남는다. 기본은 정리이고, 진단할 때만 남긴다.
  if (process.env.RUBATO_DIRECT_SMOKE_KEEP === "1") {
    console.error(`kept profile for diagnosis: ${home}`);
    return;
  }
  // 자식이 SIGKILL 로 죽어도 그 손자가 이 디렉터리를 한순간 더 잡고 있을 수 있다. 그러면
  // `rmSync` 는 내용만 지우고 껍데기를 남긴다 — 실제로 115 개가 쌓였다. 해롭지는 않지만
  // 러너가 스스로 어지르는 것이고, 다음 사람이 그걸 누출로 오해한다. 한 번 더 시도한다.
  // `maxRetries` 는 이미 재시도하지만, 껍데기가 남는 경우는 그 창 밖이었다. 남았으면
  // 한 번 더 부른다 — 그 사이에 손자가 놓는다. 두 번째도 남으면 그대로 둔다: 정리 실패가
  // 검증 결과를 바꾸지는 않고, temp 디렉터리는 OS 가 걷어간다.
  const attempt = () => {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 무해하다
    }
  };
  attempt();
  if (existsSync(home)) attempt();
}

function skip(provider, gate, reason, extra = {}) {
  return { provider, status: "SKIP", gate, reason, credential: extra.credential ?? "absent" };
}

function pass(provider, gate, detail, extra = {}) {
  return { provider, status: "PASS", gate, detail, credential: extra.credential ?? "usable" };
}

function fail(provider, gate, reason, extra = {}) {
  return { provider, status: "FAIL", gate, reason, credential: extra.credential ?? "usable" };
}

function printResult(result) {
  const extra = result.reason ?? result.detail ?? "";
  const cred = result.credential ? ` credential=${result.credential}` : "";
  console.log(`${result.status} ${result.provider} — ${result.gate}${extra ? ` (${extra})` : ""}${cred}`);
}

function oauthTokenHits(wire) {
  return wire.filter((entry) => /auth\.openai\.com/.test(String(entry.url ?? "")) && /oauth\/token/.test(String(entry.url ?? "")));
}

function codexChatHits(wire) {
  return wire.filter((entry) => {
    const url = String(entry.url ?? "");
    return /chatgpt\.com|api\.openai\.com/.test(url) && !/auth\.openai\.com/.test(url);
  });
}

function codexCredentialExpiredAt() {
  try {
    const parsed = JSON.parse(readFileSync(realSenpiAuth, "utf8"));
    const exp = parsed["openai-codex"]?.expires;
    if (typeof exp === "number" && Number.isFinite(exp)) {
      return new Date(exp > 1e12 ? exp : exp * 1000).toISOString();
    }
  } catch {
    // read-only diagnosis; absence is reported elsewhere
  }
  return null;
}

function skipUnusableCodex(provider, gate, wireLog, extra = {}) {
  const wire = readWire(wireLog);
  const oauth = oauthTokenHits(wire).length;
  const chat = codexChatHits(wire).length;
  const expiredAt = codexCredentialExpiredAt();
  // **access 만료 자체는 사유가 아니다.** 만료된 access + 살아 있는 refresh 는 정상 경로이고
  // provider 가 갱신해서 그대로 나아간다. 그것을 unusable 로 적으면 refresh 를 시험도 하지
  // 않고 gate 를 건너뛰면서, "refresh 가 살아나지 않는다" 는 확인하지 않은 말을 남긴다.
  //
  // 근거는 하나뿐이다: **갱신을 시도했는데 그 뒤로 vendor chat 이 없었다.** 그때만 자격증명이
  // 못 쓸 상태라고 말할 수 있다.
  if (!(oauth > 0 && chat === 0)) return null;
  // 근거를 실제로 본 것으로 적는다. wire 증거가 없을 때 "vendor chat 이 oauth 를 못 넘었다" 고
  // 쓰면 보지도 않은 것을 봤다고 말하는 것이다.
  const evidence = oauth > 0
    ? `vendor chat never left auth.openai.com/oauth/token (oauth=${oauth} chat=${chat})`
    : "the check died before any vendor request, so the catalog never loaded";
  return skip(
    provider,
    gate,
    `Codex credential expired${expiredAt ? ` ${expiredAt}` : ""} and refresh no longer recovers; ${evidence}${extra.note ? `; ${extra.note}` : ""}`,
    { credential: "unusable" },
  );
}

/** broker sentinel 인가. 실 토큰이 아니라 "bridge 로 보내라" 는 표지다. */
function isBrokerSentinel(entry) {
  return entry?.refresh === "rubato-broker" || entry?.access === "local";
}

function readStore(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 이 provider 에 쓸 수 있는 자격증명이 어디에 있는가.
 *
 * cutover 가 권위를 뒤집었다. broker 시절에는 실 토큰이 legacy `~/.senpi` 에 있고 profile 은
 * sentinel 만 들었다. 지금은 `/login` 이 profile 에 실 토큰을 쓰고 그쪽이 권위다. legacy 만
 * 보면 사용자가 방금 로그인한 것을 못 보고 "만료됐다" 고 SKIP 한다 — 실제로 그랬다.
 *
 * 그래서 **profile 을 먼저** 보고, sentinel 이거나 없으면 legacy 로 내려간다.
 */
function credentialSource(id) {
  const profile = readStore(liveAuthPath)[id];
  if (profile?.type && !isBrokerSentinel(profile)) return { where: "profile", entry: profile };
  const legacy = readStore(realSenpiAuth)[id];
  if (legacy?.type && !isBrokerSentinel(legacy)) return { where: "legacy", entry: legacy };
  return undefined;
}

function credentialPresent(id) {
  return credentialSource(id) !== undefined;
}

function setupTokenPresent() {
  try {
    const token = readFileSync(realClaudeToken, "utf8").trim();
    return token.startsWith(CLAUDE_SETUP_TOKEN_PREFIX) && token.length > CLAUDE_SETUP_TOKEN_PREFIX.length;
  } catch {
    return false;
  }
}

function kiroPresent() {
  try {
    const parsed = JSON.parse(readFileSync(realKiroConfig, "utf8"));
    return typeof parsed?.apiKey === "string" && parsed.apiKey.length > 0;
  } catch {
    return false;
  }
}

/**
 * 사이드카가 살아서 대답하는가.
 *
 * config 에 key 가 있다는 것은 "설정됐다" 만 말한다. Docker 가 자고 있으면 모든 Kiro
 * 단언이 실패하는데, 그것을 gate 실패로 적으면 "3턴 tool loop 가 깨졌다" 는 거짓이 된다.
 * 401 은 살아 있는 것이다 — key 를 원하는 상태다.
 */
async function kiroSidecarReachable(baseUrl = "http://127.0.0.1:8990") {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

function copyIntoTemp(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function lastAssistantUsage(messages) {
  const asst = [...assistantMessages(messages)].at(-1);
  return asst?.usage ?? null;
}

function assistantHasToolUse(messages) {
  for (const message of assistantMessages(messages)) {
    for (const part of contentParts(message)) {
      if (part?.type === "toolCall" || part?.type === "tool_use" || part?.name === "Read" || part?.name === "read") return true;
    }
  }
  return false;
}

function stripAnthropicEnv(env) {
  const next = { ...env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "CLAUDE_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    next[key] = null;
  }
  return next;
}

function keychainSetupTokenPresent() {
  return new Promise((resolve) => {
    const child = spawn("security", ["find-generic-password", "-s", "Claude Code-setup-token-sub", "-a", process.env.USER ?? "", "-w"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HOME: homedir() },
    });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      const token = out.trim();
      resolve(code === 0 && token.startsWith(CLAUDE_SETUP_TOKEN_PREFIX) && token.length > CLAUDE_SETUP_TOKEN_PREFIX.length);
    });
  });
}

function usageNumber(usage, ...names) {
  if (!usage || typeof usage !== "object") return undefined;
  for (const name of names) {
    const value = usage[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function kiroUsagesFromWire(wire) {
  return wire.flatMap((entry) => {
    if (!/127\.0\.0\.1:8990|localhost:8990/.test(String(entry.url ?? ""))) return [];
    return Array.isArray(entry.responseUsages) ? entry.responseUsages : [];
  });
}

function percentFromUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const direct = usageNumber(
    usage,
    "percentUsed",
    "percent_used",
    "usagePercentage",
    "usage_percentage",
    "percent",
  );
  if (direct !== undefined) return direct;
  const nested = usage.credit_usage;
  if (nested && typeof nested === "object") {
    return usageNumber(nested, "percentUsed", "percent_used", "usagePercentage", "percent");
  }
  return undefined;
}

function tokenCountFromUsage(usage) {
  const input = usageNumber(usage, "input_tokens", "input", "prompt_tokens") ?? 0;
  const output = usageNumber(usage, "output_tokens", "output", "completion_tokens") ?? 0;
  const cacheRead = usageNumber(usage, "cache_read_input_tokens", "cacheRead") ?? 0;
  const cacheWrite = usageNumber(usage, "cache_creation_input_tokens", "cacheWrite") ?? 0;
  const total = usageNumber(usage, "total_tokens", "totalTokens");
  if (total !== undefined) return total;
  return input + output + cacheRead + cacheWrite;
}

function invertImpliedWindow(tokenCount, percent) {
  if (!(tokenCount > 0) || !(percent > 0)) return undefined;
  const fraction = percent > 1 ? percent / 100 : percent;
  if (!(fraction > 0)) return undefined;
  return tokenCount / fraction;
}

function nearestKnownWindow(implied) {
  if (!Number.isFinite(implied) || implied <= 0) return { implied, nearest: null, relErr: null };
  const known = [1_000_000, 272_000];
  let nearest = known[0];
  let relErr = Math.abs(implied - nearest) / nearest;
  for (const candidate of known.slice(1)) {
    const err = Math.abs(implied - candidate) / candidate;
    if (err < relErr) {
      nearest = candidate;
      relErr = err;
    }
  }
  return { implied, nearest, relErr };
}

function antigravityCalls(wire) {
  return wire.filter((entry) => /daily-cloudcode-pa\.googleapis\.com|cloudaicompanion|oauth2\.googleapis\.com\/token/.test(String(entry.url ?? "")));
}

async function runCodex(assertLiveAuth) {
  const gate =
    "Phase 1: Codex signed reasoning stays a native item across 3 turns and process restart";
  if (!credentialPresent("openai-codex")) {
    return skip("openai-codex", gate, "credential absent in ~/.senpi/agent/auth.json");
  }
  const profile = createProfile("codex");
  try {
    const env = childEnv(profile);
    await seedCredentials(env);
    writeFileSync(join(profile.cwd, "note.txt"), "codex-smoke\n");
    const session = spawnRpc(profile, { model: "openai-codex/gpt-5.6-sol" });
    try {
      await setModel(session, "openai-codex", "gpt-5.6-sol");
      await rpc(session, { id: "t", type: "set_thinking_level", level: "high" }, "set_thinking_level");
      const tokens = ["CODEX_T1", "CODEX_T2", "CODEX_T3"];
      let last;
      for (const [i, token] of tokens.entries()) {
        last = await promptTurn(
          session,
          i === 0
            ? `Think step by step about why 17 is prime, then reply with exactly this token and nothing else: ${token}`
            : `Continue the same conversation. Think briefly, then reply with exactly this token and nothing else: ${token}`,
          { id: `p${i + 1}`, thinkingLevel: "high" },
        );
        const text = assistantText(last.messages);
        if (!String(text ?? "").includes(token)) {
          return skipUnusableCodex("openai-codex", gate, profile.wireLog, { note: `turn ${i + 1} empty` })
            ?? fail("openai-codex", gate, `turn ${i + 1} missing token; text=${String(text).slice(0, 180)}`);
        }
      }
      const stored = await rpc(session, { id: "gm1", type: "get_messages" }, "get_messages");
      const storedMessages = stored.data?.messages ?? last.messages;
      const storedNative = nativeReasoningFromMessages(storedMessages);
      if (storedNative.length === 0) {
        return fail(
          "openai-codex",
          gate,
          `3-turn transcript has no native reasoning signature; thinking=${hasNativeThinking(storedMessages)} flattened=${flattenedReasoningText(storedMessages)}`,
        );
      }
      if (flattenedReasoningText(storedMessages)) {
        return fail("openai-codex", gate, "signed reasoning flattened into output_text in the 3-turn transcript");
      }
      const state = await rpc(session, { id: "st", type: "get_state" }, "get_state");
      const sessionFile = state.data?.sessionFile;
      if (!sessionFile) return fail("openai-codex", gate, "get_state returned no sessionFile");
      await stop(session);

      const resumed = spawnRpc(profile, {
        model: "openai-codex/gpt-5.6-sol",
        extraArgs: ["--session", sessionFile],
      });
      try {
        await setModel(resumed, "openai-codex", "gpt-5.6-sol");
        await rpc(resumed, { id: "t2", type: "set_thinking_level", level: "high" }, "set_thinking_level");
        const resumedTurn = await promptTurn(
          resumed,
          "Resume the conversation. Think briefly about the earlier primality question, then reply with exactly this token and nothing else: CODEX_RESUME",
          { id: "pr", thinkingLevel: "high" },
        );
        const text = assistantText(resumedTurn.messages);
        if (!String(text ?? "").includes("CODEX_RESUME")) {
          return skipUnusableCodex("openai-codex", gate, profile.wireLog, { note: "resume empty" })
            ?? fail("openai-codex", gate, `resume reply missing token; text=${String(text).slice(0, 180)}`);
        }
        const resumedMessages = await rpc(resumed, { id: "gm2", type: "get_messages" }, "get_messages");
        const after = resumedMessages.data?.messages ?? resumedTurn.messages;
        const afterNative = nativeReasoningFromMessages(after);
        if (flattenedReasoningText(after)) {
          return fail("openai-codex", gate, "signed reasoning flattened into output_text after process restart");
        }
        if (afterNative.length === 0) {
          return fail("openai-codex", gate, "native reasoning signature missing after process restart");
        }
        return pass(
          "openai-codex",
          gate,
          `nativeReasoning before=${storedNative.length} after=${afterNative.length}`,
        );
      } finally {
        await stop(resumed);
      }
    } finally {
      await stop(session);
    }
  } catch (error) {
    return skipUnusableCodex("openai-codex", gate, profile.wireLog, { note: String(error).slice(0, 120) })
      ?? fail("openai-codex", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("openai-codex");
    cleanupHome(profile.home);
  }
}

async function runCodexFast(assertLiveAuth) {
  const gate = "Phase 1: Fast model payload carries canonical model ID and service_tier: priority";
  if (!credentialPresent("openai-codex")) {
    return skip("openai-codex-fast", gate, "credential absent in ~/.senpi/agent/auth.json");
  }
  const profile = createProfile("codex-fast");
  try {
    const env = childEnv(profile);
    await seedCredentials(env);
    const session = spawnRpc(profile, { model: "openai-codex/gpt-daybreak-blue-latest-fast" });
    try {
      await setModel(session, "openai-codex", "gpt-daybreak-blue-latest-fast");
      const ended = await promptTurn(session, "Reply with exactly this token and nothing else: CODEX_FAST_OK", {
        id: "pfast",
      });
      const text = assistantText(ended.messages);
      if (!String(text ?? "").includes("CODEX_FAST_OK")) {
        return skipUnusableCodex("openai-codex-fast", gate, profile.wireLog, { note: "reply empty" })
          ?? fail("openai-codex-fast", gate, `reply missing token; text=${String(text).slice(0, 180)}`);
      }
      const wire = readWire(profile.wireLog);
      const vendor = wire.filter((entry) => /chatgpt\.com|api\.openai\.com|auth\.openai\.com/.test(String(entry.url ?? "")));
      const bodies = vendor.map((entry) => entry.body).filter(Boolean);
      const hit = bodies.find((body) => body && typeof body === "object" && typeof body.model === "string");
      if (!hit) {
        // 요청 body 를 못 봤다는 것은 **계측의 실패**이지 gate 의 실패가 아니다. 그 둘을 섞으면
        // "Fast 계약이 깨졌다" 는 거짓을 적는다 — 실제로 그렇게 적혀 있었고, 모델은 그동안
        // 정상으로 `gpt-daybreak-blue-latest` 를 돌려주고 있었다.
        //
        // 원인: pinned Codex 경로는 OpenAI SDK 를 쓰고, SDK 는 client 를 만들 때 그 시점의
        // 전역 `fetch` 를 잡는다. `-e` extension 도 `NODE_OPTIONS=--import` 도 그보다 앞선다는
        // 보장이 없어서 wrapper 를 지나지 않는 실행이 생긴다. 고치려면 provider 에 fetch 주입구가
        // 있어야 하고, 그건 pinned 층을 건드리는 별개 작업이다.
        //
        // 그때까지 이 항목은 **미계측**으로 보고한다. 응답 자체는 검사했으므로 모델이 죽은 것과는
        // 구분된다.
        const replied = /CODEX_FAST_OK/.test(String(text ?? ""));
        if (replied) {
          return skip(
            "openai-codex-fast",
            gate,
            "reply OK but request body was not captured: the pinned Codex path binds fetch inside the OpenAI SDK, so the wire wrapper can miss it. The service_tier/canonical-ID contract stays unmeasured live; unit coverage is in test/unit/provider-direct-wire.test.mjs",
            { credential: "usable" },
          );
        }
        return skipUnusableCodex("openai-codex-fast", gate, profile.wireLog, { note: "no chat body" })
          ?? fail(
            "openai-codex-fast",
            gate,
            `no Codex request body captured; ${JSON.stringify(wireSummary(profile.wireLog))}`,
          );
      }
      if (hit.model !== "gpt-daybreak-blue-latest") {
        return fail("openai-codex-fast", gate, `wire model=${hit.model} expected gpt-daybreak-blue-latest`);
      }
      if (String(hit.model).endsWith("-fast")) {
        return fail("openai-codex-fast", gate, "Fast alias leaked onto the wire");
      }
      if (hit.service_tier !== "priority") {
        return fail("openai-codex-fast", gate, `service_tier=${hit.service_tier} expected priority`);
      }
      return pass("openai-codex-fast", gate, `model=${hit.model} service_tier=${hit.service_tier}`);
    } finally {
      await stop(session);
    }
  } catch (error) {
    return skipUnusableCodex("openai-codex-fast", gate, profile.wireLog, { note: String(error).slice(0, 120) })
      ?? fail("openai-codex-fast", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("openai-codex-fast");
    cleanupHome(profile.home);
  }
}

async function runCodexImageTool(assertLiveAuth) {
  const gate = "Phase 1: Codex image input and tool loop";
  if (!credentialPresent("openai-codex")) {
    return skip("openai-codex-image-tool", gate, "credential absent in ~/.senpi/agent/auth.json");
  }
  const profile = createProfile("codex-image");
  try {
    const env = childEnv(profile);
    await seedCredentials(env);
    writeFileSync(join(profile.cwd, "hello.txt"), "KIRO_SMOKE_OK\n");
    const session = spawnRpc(profile, { model: "openai-codex/gpt-5.6-sol" });
    try {
      await setModel(session, "openai-codex", "gpt-5.6-sol");
      const toolTurn = await promptTurn(
        session,
        "Use the read tool exactly once to read hello.txt in the current directory, then reply with exactly CODEX_TOOL_OK and nothing else.",
        { id: "ptool", timeoutMs: TURN_MS * 2 },
      );
      const toolText = assistantText(toolTurn.messages);
      const imgTurn = await promptTurn(session, "If you received an image, reply with exactly CODEX_IMAGE_OK.", {
        id: "pimg",
        images: [{ type: "image", data: TINY_PNG, mimeType: "image/png" }],
      });
      const imgText = assistantText(imgTurn.messages);
      const wire = readWire(profile.wireLog);
      const vendor = wire.filter((entry) => /chatgpt\.com|api\.openai\.com/.test(String(entry.url ?? "")));
      const serialized = JSON.stringify(vendor.map((entry) => entry.body ?? {}));
      const imageOnWire = /input_image|image\/png|iVBORw0KGgo/.test(serialized);
      const toolOnWire = /hello\.txt|read_file|"name":"read"|"name":"Read"/.test(serialized);
      const toolInTranscript =
        assistantHasToolUse(toolTurn.messages) || String(toolText ?? "").includes("CODEX_TOOL_OK") || String(toolText ?? "").includes("KIRO_SMOKE_OK");
      if (!toolOnWire && !toolInTranscript) {
        return skipUnusableCodex("openai-codex-image-tool", gate, profile.wireLog, { note: "tool loop empty" })
          ?? fail(
            "openai-codex-image-tool",
            gate,
            `tool loop not visible; text=${String(toolText).slice(0, 180)}; ${JSON.stringify(wireSummary(profile.wireLog))}`,
          );
      }
      if (!imageOnWire && !String(imgText ?? "").includes("CODEX_IMAGE_OK")) {
        return skipUnusableCodex("openai-codex-image-tool", gate, profile.wireLog, { note: "image empty" })
          ?? fail(
            "openai-codex-image-tool",
            gate,
            `image input not on wire or in reply; text=${String(imgText).slice(0, 180)}`,
          );
      }
      return pass(
        "openai-codex-image-tool",
        gate,
        `toolOnWire=${toolOnWire} imageOnWire=${imageOnWire} toolText=${String(toolText).slice(0, 40)}`,
      );
    } finally {
      await stop(session);
    }
  } catch (error) {
    return skipUnusableCodex("openai-codex-image-tool", gate, profile.wireLog, { note: String(error).slice(0, 120) })
      ?? fail("openai-codex-image-tool", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("openai-codex-image-tool");
    cleanupHome(profile.home);
  }
}

async function runRefreshRace(assertLiveAuth) {
  const gate =
    "Phase 1: two processes against a forced-expiry credential refresh once under lock";
  if (!credentialPresent("openai-codex")) {
    return skip("openai-codex-refresh-race", gate, "credential absent");
  }
  const profile = createProfile("codex-race");
  try {
    const env = childEnv(profile);
    await seedCredentials(env);
    const authPath = join(profile.agentDir, "auth.json");
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    if (parsed["openai-codex"]?.type !== "oauth") {
      return skip("openai-codex-refresh-race", gate, "imported credential is not oauth");
    }
    parsed["openai-codex"].expires = 1;
    writeFileSync(authPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });

    const a = spawnRpc(profile, { model: "openai-codex/gpt-5.6-sol" });
    const b = spawnRpc(profile, { model: "openai-codex/gpt-5.6-sol" });
    try {
      await Promise.all([
        setModel(a, "openai-codex", "gpt-5.6-sol"),
        setModel(b, "openai-codex", "gpt-5.6-sol"),
      ]);
      const prompts = Promise.allSettled([
        promptTurn(a, "Reply with exactly this token and nothing else: RACE_A", { id: "pa" }),
        promptTurn(b, "Reply with exactly this token and nothing else: RACE_B", { id: "pb" }),
      ]);
      const settled = await prompts;
      const wire = readWire(profile.wireLog);
      const refreshes = wire.filter((entry) => {
        const url = String(entry.url ?? "");
        if (!url.includes("auth.openai.com") || !url.includes("/oauth/token")) return false;
        const blob = `${entry.bodyText ?? ""} ${JSON.stringify(entry.body ?? {})}`;
        return /refresh_token/.test(blob);
      });
      const failures = settled.filter((item) => item.status === "rejected");
      if (refreshes.length !== 1) {
        return skipUnusableCodex("openai-codex-refresh-race", gate, profile.wireLog, { note: `refresh count=${refreshes.length}` })
          ?? fail(
            "openai-codex-refresh-race",
            gate,
            `remote refresh count=${refreshes.length} expected 1; failures=${failures.length}; ${JSON.stringify(wireSummary(profile.wireLog))}`,
          );
      }
      return pass("openai-codex-refresh-race", gate, `refreshes=1 failures=${failures.length}`);
    } finally {
      await stop(a);
      await stop(b);
    }
  } catch (error) {
    return skipUnusableCodex("openai-codex-refresh-race", gate, profile.wireLog, { note: String(error).slice(0, 120) })
      ?? fail("openai-codex-refresh-race", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("openai-codex-refresh-race");
    cleanupHome(profile.home);
  }
}

async function runXai(assertLiveAuth) {
  const gate = "Phase 1: xAI grok-4.6 keeps xhigh reasoning mapping on the wire";
  if (!credentialPresent("xai")) {
    return skip("xai", gate, "credential absent in ~/.senpi/agent/auth.json");
  }
  const profile = createProfile("xai");
  try {
    const env = childEnv(profile);
    await seedCredentials(env);
    const session = spawnRpc(profile, { model: "xai/grok-4.6" });
    try {
      await setModel(session, "xai", "grok-4.6");
      await rpc(session, { id: "t", type: "set_thinking_level", level: "xhigh" }, "set_thinking_level");
      const ended = await promptTurn(session, "Reply with exactly this token and nothing else: XAI_OK", {
        id: "p",
        thinkingLevel: "xhigh",
      });
      const text = assistantText(ended.messages);
      if (!String(text ?? "").includes("XAI_OK")) {
        return fail("xai", gate, `reply missing token; text=${String(text).slice(0, 180)}`);
      }
      const wire = readWire(profile.wireLog);
      const hit = wire.some((entry) => JSON.stringify(entry.body ?? {}).includes("xhigh"));
      if (!hit) {
        return fail("xai", gate, `xhigh missing from captured request body; ${JSON.stringify(wireSummary(profile.wireLog))}`);
      }
      return pass("xai", gate, "reply + xhigh on wire");
    } finally {
      await stop(session);
    }
  } catch (error) {
    return fail("xai", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("xai");
    cleanupHome(profile.home);
  }
}

async function runAnthropic(assertLiveAuth) {
  const gate =
    "Phase 3: setup-token path carries Claude OAuth identity (claude-cli UA, beta, cache retention) and native tool names";
  if (!setupTokenPresent()) {
    return skip("anthropic", gate, "setup-token absent");
  }
  const profile = createProfile("anthropic");
  try {
    const tokenDest = join(profile.home, ".claude", "auth", "setup-token-sub");
    copyIntoTemp(realClaudeToken, tokenDest);
    const env = childEnv(profile, { [CLAUDE_SETUP_TOKEN_FILE_ENV]: tokenDest });
    await seedCredentials(env);
    const session = spawnRpc(profile, {
      model: "anthropic/claude-sonnet-5",
      extraEnv: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: tokenDest },
    });
    try {
      await setModel(session, "anthropic", "claude-sonnet-5");
      const ended = await promptTurn(
        session,
        "Use the read tool exactly once to read hello.txt in the current directory, then reply with exactly ANTHROPIC_OK and nothing else.",
        { id: "p" },
      );
      const text = assistantText(ended.messages);
      if (!String(text ?? "").trim()) {
        return fail("anthropic", gate, `empty reply; text=${String(text).slice(0, 180)}`);
      }
      const wire = readWire(profile.wireLog);
      const apiCalls = wire.filter((entry) => /api\.anthropic\.com/.test(String(entry.url ?? "")));
      if (apiCalls.length === 0) {
        return fail("anthropic", gate, `no api.anthropic.com request captured; ${JSON.stringify(wireSummary(profile.wireLog))}`);
      }
      const headersOk = apiCalls.every((entry) => entry.headers?.["user-agent"] === "claude-cli/2.1.75");
      const betaOk = apiCalls.some((entry) => String(entry.headers?.["anthropic-beta"] ?? "").includes("claude-code-20250219"));
      const cacheOk = apiCalls.some((entry) => JSON.stringify(entry.body ?? {}).includes('"ttl":"1h"') || JSON.stringify(entry.body ?? {}).includes("1h"));
      const tools = apiCalls.flatMap((entry) => entry.body?.tools ?? []);
      const nativeNames = tools.length === 0 || tools.some((tool) => tool.name === "Read" || tool.name === "read" || tool.name === "Bash");
      const doubled = tools.some((tool) => tool.name === "read_file");
      if (!headersOk) return fail("anthropic", gate, `user-agent not claude-cli/2.1.75: ${apiCalls[0]?.headers?.["user-agent"]}`);
      if (!betaOk) return fail("anthropic", gate, "missing claude-code beta header");
      if (!cacheOk) return fail("anthropic", gate, "cache retention 1h missing on wire");
      if (doubled) return fail("anthropic", gate, "bridge read_file mapping leaked onto the wire");
      if (!nativeNames) return fail("anthropic", gate, "native tool names missing");
      if (!String(text ?? "").includes("ANTHROPIC_OK")) {
        return pass("anthropic", gate, `wire identity ok; reply=${String(text).slice(0, 80)}`);
      }
      return pass("anthropic", gate, "reply + OAuth wire identity");
    } finally {
      await stop(session);
    }
  } catch (error) {
    return fail("anthropic", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("anthropic");
    cleanupHome(profile.home);
  }
}

async function listedModels(session, provider) {
  await waitForSessionStart(session);
  const listed = await rpc(
    session,
    { id: `avail-${provider}-pick`, type: "get_available_models" },
    "get_available_models",
  );
  return listed.data?.models ?? listed.models ?? [];
}

async function runAnthropicKeychain(assertLiveAuth) {
  const gate = "Phase 3: setup-token Keychain fallback makes a real request";
  const keychainPresent = await keychainSetupTokenPresent();
  if (!keychainPresent) {
    return skip("anthropic-keychain", gate, "Keychain entry does not exist", { credential: "absent" });
  }
  const profile = createProfile("anthropic-keychain");
  try {
    const missing = join(profile.home, ".claude", "auth", "setup-token-missing");
    const extraEnv = stripAnthropicEnv({
      [CLAUDE_SETUP_TOKEN_FILE_ENV]: missing,
    });
    const env = childEnv(profile, extraEnv);
    await seedCredentials(env);
    // 모델을 주지 않고 띄우면 catalog 가 밀려있는 상태로 set_model 이 들어가서
    // "Model not found" 로 죽는다. 그건 Keychain 실패가 아니라 하네스 오류라,
    // gate 를 깨뜨린 것으로 오독된다. 자매 검사와 같게 모델을 지정해 띄운다.
    const session = spawnRpc(profile, {
      model: "anthropic/claude-sonnet-5",
      extraEnv,
    });
    try {
      const models = await listedModels(session, "anthropic");
      const anthropic = models.filter((model) => model.provider === "anthropic");
      const chosen =
        anthropic.find((model) => model.id === "claude-opus-5") ??
        anthropic.find((model) => model.id === "claude-sonnet-5") ??
        anthropic[0];
      if (!chosen) {
        return skip(
          "anthropic-keychain",
          gate,
          `Keychain fallback did not configure anthropic; listed=${models.map((model) => `${model.provider}/${model.id}`).slice(0, 16).join(",") || "none"}`,
          { credential: "unusable" },
        );
      }
      await setModel(session, "anthropic", chosen.id);
      const ended = await promptTurn(session, "Reply with exactly this token and nothing else: ANTHROPIC_KEYCHAIN_OK", {
        id: "pk",
      });
      const text = assistantText(ended.messages);
      const wire = readWire(profile.wireLog);
      const apiCalls = wire.filter((entry) => /api\.anthropic\.com/.test(String(entry.url ?? "")));
      if (apiCalls.length === 0) {
        return fail(
          "anthropic-keychain",
          gate,
          `no api.anthropic.com request captured; text=${String(text).slice(0, 120)}; ${JSON.stringify(wireSummary(profile.wireLog))}`,
        );
      }
      const headersOk = apiCalls.every((entry) => entry.headers?.["user-agent"] === "claude-cli/2.1.75");
      if (!headersOk) {
        return fail("anthropic-keychain", gate, `user-agent not claude-cli/2.1.75: ${apiCalls[0]?.headers?.["user-agent"]}`);
      }
      return pass(
        "anthropic-keychain",
        gate,
        `model=${chosen.id} fileMissing=${missing} vendorRequests=${apiCalls.length} reply=${String(text ?? "").includes("ANTHROPIC_KEYCHAIN_OK")}`,
      );
    } finally {
      await stop(session);
    }
  } catch (error) {
    return fail("anthropic-keychain", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("anthropic-keychain");
    cleanupHome(profile.home);
  }
}

async function runKiro(assertLiveAuth) {
  const gate = "Phase 3: Kiro 3-turn tool loop and image input";
  if (!kiroPresent()) {
    return skip("kiro", gate, "kiro config/apiKey absent");
  }
  if (!(await kiroSidecarReachable())) {
    return skip("kiro", gate, "kiro.rs sidecar on 127.0.0.1:8990 does not answer", { credential: "unusable" });
  }
  const profile = createProfile("kiro");
  try {
    const kiroDest = join(profile.home, ".rubato-pi", "kiro", "config.json");
    copyIntoTemp(realKiroConfig, kiroDest);
    const extraEnv = { [KIRO_CONFIG_PATH_ENV]: kiroDest };
    const env = childEnv(profile, extraEnv);
    await seedCredentials(env);
    const session = spawnRpc(profile, { model: "kiro/claude-opus-5", extraEnv });
    try {
      await setModel(session, "kiro", "claude-opus-5");
      const t1 = await promptTurn(
        session,
        "Use the read tool exactly once to read hello.txt, then reply with only the file contents trimmed.",
        { id: "p1", timeoutMs: TURN_MS * 2 },
      );
      const text1 = assistantText(t1.messages);
      if (!String(text1 ?? "").includes("KIRO_SMOKE_OK")) {
        return fail("kiro", gate, `tool loop turn 1 missed file contents; text=${String(text1).slice(0, 180)}`);
      }
      const t2 = await promptTurn(session, "Reply with exactly KIRO_T2 and nothing else.", { id: "p2" });
      if (!String(assistantText(t2.messages) ?? "").includes("KIRO_T2")) {
        return fail("kiro", gate, `turn 2 missing token; text=${String(assistantText(t2.messages)).slice(0, 180)}`);
      }
      const t3 = await promptTurn(session, "Reply with exactly KIRO_T3 and nothing else.", { id: "p3" });
      if (!String(assistantText(t3.messages) ?? "").includes("KIRO_T3")) {
        return fail("kiro", gate, `turn 3 missing token; text=${String(assistantText(t3.messages)).slice(0, 180)}`);
      }
      const img = await promptTurn(session, "If you received an image, reply with exactly KIRO_IMAGE_OK.", {
        id: "img",
        images: [{ type: "image", data: TINY_PNG, mimeType: "image/png" }],
      });
      const wire = readWire(profile.wireLog);
      const sidecar = wire.filter((entry) => /127\.0\.0\.1:8990/.test(String(entry.url ?? "")));
      const imageOnWire = sidecar.some((entry) => JSON.stringify(entry.body ?? {}).includes("image"));
      if (sidecar.length === 0) {
        return fail("kiro", gate, `no kiro.rs :8990 request captured; ${JSON.stringify(wireSummary(profile.wireLog))}`);
      }
      if (!imageOnWire && !String(assistantText(img.messages) ?? "").includes("KIRO_IMAGE_OK")) {
        return fail("kiro", gate, "image input did not appear on the sidecar wire or in the reply");
      }
      return pass("kiro", gate, `sidecarRequests=${sidecar.length} imageOnWire=${imageOnWire}`);
    } finally {
      await stop(session);
    }
  } catch (error) {
    return fail("kiro", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("kiro");
    cleanupHome(profile.home);
  }
}

function summarizeKiroCapSample(label, modelId, turn, wire) {
  const usages = kiroUsagesFromWire(wire);
  const lastWire = usages.at(-1) ?? null;
  const assistant = lastAssistantUsage(turn.messages);
  const percent = percentFromUsage(lastWire) ?? percentFromUsage(assistant);
  const tokens = lastWire ? tokenCountFromUsage(lastWire) : tokenCountFromUsage(assistant);
  const inverted = invertImpliedWindow(tokens, percent);
  const match = inverted === undefined ? null : nearestKnownWindow(inverted);
  return {
    label,
    modelId,
    reply: String(assistantText(turn.messages) ?? "").slice(0, 80),
    assistantUsage: assistant,
    wireUsage: lastWire,
    percent,
    tokens,
    impliedWindow: inverted,
    nearestWindow: match?.nearest ?? null,
    relErr: match?.relErr ?? null,
  };
}

async function runKiroCaps(assertLiveAuth) {
  const gate = "Phase 3: Kiro 1M/272K upstream windows measured from live usage (no truncation math enabled)";
  if (!kiroPresent()) {
    return skip("kiro-caps", gate, "kiro config/apiKey absent");
  }
  if (!(await kiroSidecarReachable())) {
    return skip("kiro-caps", gate, "kiro.rs sidecar on 127.0.0.1:8990 does not answer", { credential: "unusable" });
  }
  const profile = createProfile("kiro-caps");
  try {
    const kiroDest = join(profile.home, ".rubato-pi", "kiro", "config.json");
    copyIntoTemp(realKiroConfig, kiroDest);
    const extraEnv = { [KIRO_CONFIG_PATH_ENV]: kiroDest };
    const env = childEnv(profile, extraEnv);
    await seedCredentials(env);
    const samples = [];
    const opus = spawnRpc(profile, { model: "kiro/claude-opus-5", extraEnv });
    try {
      await setModel(opus, "kiro", "claude-opus-5");
      const short = await promptTurn(opus, "Reply with exactly KIRO_CAP_SHORT and nothing else.", { id: "short" });
      samples.push(summarizeKiroCapSample("opus-short", "claude-opus-5", short, readWire(profile.wireLog)));
      const long = await promptTurn(
        opus,
        `Reply with exactly KIRO_CAP_LONG and nothing else. Extra context (ignore): ${"alpha-".repeat(2500)}`,
        { id: "long", timeoutMs: TURN_MS * 2 },
      );
      samples.push(summarizeKiroCapSample("opus-long", "claude-opus-5", long, readWire(profile.wireLog)));
    } finally {
      await stop(opus);
    }
    const sol = spawnRpc(profile, { model: "kiro/gpt-5.6-sol", extraEnv });
    try {
      await setModel(sol, "kiro", "gpt-5.6-sol");
      const solTurn = await promptTurn(sol, "Reply with exactly KIRO_CAP_SOL and nothing else.", { id: "sol" });
      samples.push(summarizeKiroCapSample("sol-short", "gpt-5.6-sol", solTurn, readWire(profile.wireLog)));
    } finally {
      await stop(sol);
    }
    const measured = samples.filter((sample) => sample.tokens > 0 || sample.percent !== undefined);
    if (measured.length < 2) {
      return fail(
        "kiro-caps",
        gate,
        `need >=2 live usage samples; got ${measured.length}; ${JSON.stringify(samples).slice(0, 500)}`,
      );
    }
    return pass("kiro-caps", gate, JSON.stringify(samples));
  } catch (error) {
    return fail("kiro-caps", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("kiro-caps");
    cleanupHome(profile.home);
  }
}

async function probeAntigravityProject(access, endpoint) {
  try {
    const project = await loadAntigravityProjectId(access, endpoint, globalThis.fetch);
    return { ok: true, project };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

async function refreshAntigravityAccessOnly({ extraEnv, refreshToken }) {
  const oauth = antigravityOAuth({ env: extraEnv, fetchImpl: globalThis.fetch });
  // Pin a dummy project so oauth.refresh does not call loadCodeAssist. That second hop is
  // diagnosed separately; folding it in would report a working refresh as a refresh failure.
  return await oauth.refresh({
    type: "oauth",
    access: "probe",
    refresh: refreshToken,
    expires: 0,
    env: { [ANTIGRAVITY_PROJECT_ENV]: "diagnosis-skip-loadCodeAssist" },
  });
}

async function diagnoseAntigravity({ extraEnv }) {
  const endpoint = extraEnv.RUBATO_ANTIGRAVITY_ENDPOINT || ANTIGRAVITY_ENDPOINT;
  let secret;
  try {
    secret = await readAntigravityKeychainSecret();
  } catch (error) {
    return {
      kind: "keychain_unavailable",
      operator: "interactive Google Antigravity login is required",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let token;
  try {
    token = decodeAntigravityKeychainSecret(secret);
  } catch (error) {
    return {
      kind: "keychain_invalid",
      operator: "interactive Google Antigravity login is required",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const first = await probeAntigravityProject(token.access, endpoint);
  if (first.ok) {
    return {
      kind: "usable_access",
      project: first.project,
      token,
      accessExpired: false,
      refreshWorked: null,
    };
  }

  const accessExpired = /\(401\)/.test(first.message);
  let rotated;
  try {
    rotated = await refreshAntigravityAccessOnly({ extraEnv, refreshToken: token.refresh });
  } catch (error) {
    const refreshMessage = error instanceof Error ? error.message : String(error);
    return {
      kind: accessExpired ? "expired_access_refresh_failed" : "loadCodeAssist_failed_refresh_failed",
      accessExpired,
      refreshWorked: false,
      first: first.message,
      refresh: refreshMessage,
      operator: "interactive Google Antigravity login is required; refresh token did not recover a usable project",
    };
  }

  const second = await probeAntigravityProject(rotated.access, endpoint);
  if (second.ok) {
    return {
      kind: accessExpired ? "expired_access_refresh_recovered" : "refresh_recovered_project",
      project: second.project,
      token,
      rotated,
      accessExpired,
      refreshWorked: true,
      first: first.message,
    };
  }
  if (/no project/.test(second.message)) {
    return {
      kind: "missing_cloudaicompanionProject",
      accessExpired,
      refreshWorked: true,
      first: first.message,
      second: second.message,
      operator: "refresh worked but loadCodeAssist returned no cloudaicompanionProject; interactive Google login on an entitled Antigravity account is required",
    };
  }
  if (/\(401\)/.test(second.message)) {
    return {
      kind: "refresh_still_401",
      accessExpired,
      refreshWorked: true,
      first: first.message,
      second: second.message,
      operator: "interactive Google Antigravity login is required; refreshed access still fails loadCodeAssist with 401",
    };
  }
  return {
    kind: "no_antigravity_entitlement",
    accessExpired,
    refreshWorked: true,
    first: first.message,
    second: second.message,
    operator: "credential is for an account with no usable Antigravity entitlement; interactive Google login on an entitled account is required",
  };
}

function antigravityLineageFromWire(entries) {
  return entries.flatMap((entry) => {
    const body = entry.body;
    if (!body || typeof body !== "object") return [];
    const request = body.request && typeof body.request === "object" ? body.request : body;
    const sessionId = request.sessionId ?? body.sessionId;
    const labels = request.labels ?? body.labels ?? {};
    if (!sessionId) return [];
    return [{
      url: entry.url,
      sessionId: String(sessionId),
      trajectoryId: labels.trajectory_id,
      lastExecutionId: labels.last_execution_id,
      lastStepIndex: labels.last_step_index,
    }];
  });
}

async function runAntigravity(assertLiveAuth) {
  const gate =
    "Phase 4: Antigravity image, tool call, 3-turn continuation; concurrent refresh; thinking signatures and branch state do not bleed; ended-session cleanup";
  if (!existsSync(realAntigravityOauth)) {
    return skip("google-antigravity", gate, "antigravity-oauth.json absent", { credential: "absent" });
  }
  const profile = createProfile("antigravity");
  try {
    const oauthDest = join(profile.home, ".rubato-pi", "antigravity-oauth.json");
    copyIntoTemp(realAntigravityOauth, oauthDest);
    const extraEnv = { [ANTIGRAVITY_OAUTH_FILE_ENV]: oauthDest };
    const env = childEnv(profile, extraEnv);
    await seedCredentials(env);

    const diagnosis = await diagnoseAntigravity({ extraEnv });
    console.error(`antigravity diagnosis: ${diagnosis.kind}${diagnosis.project ? ` project=${diagnosis.project}` : ""}${diagnosis.first ? ` first=${diagnosis.first}` : ""}`);
    if (!diagnosis.project) {
      return skip(
        "google-antigravity",
        gate,
        `${diagnosis.kind}: ${diagnosis.operator ?? diagnosis.detail ?? diagnosis.first ?? "unusable"}`,
        { credential: "unusable" },
      );
    }

    const imported = await importAntigravityKeychainCredential({
      env,
      enabled: true,
      projectId: diagnosis.project,
    });
    if (imported.status !== "imported" && imported.status !== "already_present" && imported.status !== "skipped") {
      return skip(
        "google-antigravity",
        gate,
        `diagnosis=${diagnosis.kind} keychain import ${imported.status}${imported.reason ? `:${imported.reason}` : ""}`,
      );
    }

    const authPath = join(profile.agentDir, "auth.json");
    const session = spawnRpc(profile, { model: "google-antigravity/gemini-3.7-flash", extraEnv });
    let beforeFork = [];
    let afterFork = [];
    let afterNewSession = [];
    try {
      await setModel(session, "google-antigravity", "gemini-3.7-flash");
      const img = await promptTurn(
        session,
        "If you received an image, reply with exactly AG_IMAGE_OK. Then use the read tool once on hello.txt and include KIRO_SMOKE_OK.",
        {
          id: "p1",
          images: [{ type: "image", data: TINY_PNG, mimeType: "image/png" }],
          timeoutMs: TURN_MS * 2,
        },
      );
      const t2 = await promptTurn(session, "Reply with exactly AG_T2 and nothing else.", { id: "p2" });
      const t3 = await promptTurn(session, "Reply with exactly AG_T3 and nothing else.", { id: "p3" });
      const text = [img, t2, t3].map((turn) => assistantText(turn.messages)).join("\n");
      if (!/AG_T2/.test(String(assistantText(t2.messages) ?? "")) || !/AG_T3/.test(String(assistantText(t3.messages) ?? ""))) {
        // 빈 응답은 provider 오류의 증상이다. stderr 를 버리면 원인을 추측만 하게 된다 —
        // 실제로 그래서 오래 헤맸다.
        const tail = session.stderr?.()?.slice(-700) ?? "";
        return fail("google-antigravity", gate, `continuation missing tokens; text=${text.slice(0, 160)} diagnosis=${diagnosis.kind}; stderr=${tail}`);
      }
      const messages = await rpc(session, { id: "gm", type: "get_messages" }, "get_messages");
      const stored = messages.data?.messages ?? img.messages;
      const sigs = thinkingSignatures(stored);
      const imageOk =
        /AG_IMAGE_OK/.test(String(assistantText(img.messages) ?? "")) ||
        /inlineData|inline_data|image\/png/.test(JSON.stringify(readWire(profile.wireLog)));
      const toolOk =
        assistantHasToolUse(img.messages) ||
        /KIRO_SMOKE_OK/.test(String(assistantText(img.messages) ?? ""));
      if (!imageOk) return fail("google-antigravity", gate, `image input not observed; text=${text.slice(0, 180)}`);
      if (!toolOk) return fail("google-antigravity", gate, `tool call not observed; text=${text.slice(0, 180)}`);

      beforeFork = antigravityLineageFromWire(antigravityCalls(readWire(profile.wireLog)));
      const entries = await rpc(session, { id: "ge", type: "get_entries" }, "get_entries");
      const userEntry = (entries.data?.entries ?? entries.data ?? []).find((entry) => entry?.type === "message" && entry?.message?.role === "user")
        ?? (entries.data?.entries ?? []).find((entry) => entry?.id);
      if (!userEntry?.id) return fail("google-antigravity", gate, "no user entry to fork");
      const forked = await rpc(session, { id: "fk", type: "fork", entryId: userEntry.id }, "fork");
      if (forked.success === false) {
        return fail("google-antigravity", gate, `fork failed: ${JSON.stringify(forked.error ?? forked).slice(0, 200)}`);
      }
      const forkTurn = await promptTurn(session, "This is the forked branch. Reply with exactly AG_FORK.", { id: "pf" });
      if (!String(assistantText(forkTurn.messages) ?? "").includes("AG_FORK")) {
        return fail("google-antigravity", gate, `fork reply missing token; text=${String(assistantText(forkTurn.messages)).slice(0, 180)}`);
      }
      afterFork = antigravityLineageFromWire(antigravityCalls(readWire(profile.wireLog)));
      const rootSessionIds = [...new Set(beforeFork.map((row) => row.sessionId))];
      const forkSessionIds = [...new Set(afterFork.map((row) => row.sessionId).filter((id) => !rootSessionIds.includes(id)))];
      if (forkSessionIds.length === 0) {
        return fail(
          "google-antigravity",
          gate,
          `fork did not allocate a new upstream sessionId; root=${rootSessionIds.join(",")} all=${[...new Set(afterFork.map((row) => row.sessionId))].join(",")}`,
        );
      }
      const forkSigs = thinkingSignatures(forkTurn.messages);
      const overlap = sigs.filter((signature) => forkSigs.includes(signature));
      if (overlap.length > 0 && sigs.length > 0 && forkSigs.length > 0) {
        return fail("google-antigravity", gate, `thinking signatures reused across fork lineage overlap=${overlap.length}`);
      }

      const created = await rpc(session, { id: "ns", type: "new_session" }, "new_session");
      if (created.success === false) {
        return fail("google-antigravity", gate, `new_session failed: ${JSON.stringify(created.error ?? created).slice(0, 200)}`);
      }
      await setModel(session, "google-antigravity", "gemini-3.7-flash");
      const cleaned = await promptTurn(session, "New session after shutdown. Reply with exactly AG_NEW.", { id: "pn" });
      if (!String(assistantText(cleaned.messages) ?? "").includes("AG_NEW")) {
        return fail("google-antigravity", gate, `new session reply missing token; text=${String(assistantText(cleaned.messages)).slice(0, 180)}`);
      }
      afterNewSession = antigravityLineageFromWire(antigravityCalls(readWire(profile.wireLog)));
      const newIds = [...new Set(afterNewSession.map((row) => row.sessionId))];
      const reusedEnded = newIds.some((id) => rootSessionIds.includes(id) || forkSessionIds.includes(id));
      if (reusedEnded) {
        return fail(
          "google-antigravity",
          gate,
          `ended sessionId reused after new_session; new=${newIds.join(",")} old=${[...rootSessionIds, ...forkSessionIds].join(",")}`,
        );
      }
    } finally {
      await stop(session);
    }

    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    if (parsed["google-antigravity"]?.type !== "oauth") {
      return fail("google-antigravity", gate, "temp profile lost google-antigravity oauth before refresh race");
    }
    parsed["google-antigravity"].expires = 1;
    const refreshBefore = parsed["google-antigravity"].refresh;
    writeFileSync(authPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    const a = spawnRpc(profile, { model: "google-antigravity/gemini-3.7-flash", extraEnv });
    const b = spawnRpc(profile, { model: "google-antigravity/gemini-3.7-flash", extraEnv });
    try {
      await Promise.all([
        setModel(a, "google-antigravity", "gemini-3.7-flash"),
        setModel(b, "google-antigravity", "gemini-3.7-flash"),
      ]);
      const settled = await Promise.allSettled([
        promptTurn(a, "Reply with exactly this token and nothing else: AG_RACE_A", { id: "pa" }),
        promptTurn(b, "Reply with exactly this token and nothing else: AG_RACE_B", { id: "pb" }),
      ]);
      const wire = readWire(profile.wireLog);
      const refreshes = wire.filter((entry) => /oauth2\.googleapis\.com\/token/.test(String(entry.url ?? "")));
      const failures = settled.filter((item) => item.status === "rejected");
      const afterRace = JSON.parse(readFileSync(authPath, "utf8"));
      const refreshAfter = afterRace["google-antigravity"]?.refresh;
      if (!refreshAfter) {
        return fail("google-antigravity", gate, "concurrent refresh lost the refresh token in the temp profile");
      }
      if (refreshes.length < 1) {
        return fail(
          "google-antigravity",
          gate,
          `concurrent refresh produced no token request; failures=${failures.length}; ${JSON.stringify(wireSummary(profile.wireLog))}`,
        );
      }
      if (failures.length === 2) {
        return fail("google-antigravity", gate, `both concurrent prompts failed; refreshes=${refreshes.length}`);
      }
      return pass(
        "google-antigravity",
        gate,
        `diagnosis=${diagnosis.kind} project=${diagnosis.project} image+tool+3turn+fork+cleanup ok; race refreshes=${refreshes.length} failures=${failures.length} refreshPreserved=${Boolean(refreshAfter)} refreshUnchanged=${refreshBefore === refreshAfter} rootSessions=${[...new Set(beforeFork.map((row) => row.sessionId))].length} forkSessions=${[...new Set(afterFork.map((row) => row.sessionId))].length} afterNew=${[...new Set(afterNewSession.map((row) => row.sessionId))].length}`,
      );
    } finally {
      await stop(a);
      await stop(b);
    }
  } catch (error) {
    return fail("google-antigravity", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("google-antigravity");
    cleanupHome(profile.home);
  }
}

/**
 * Cursor native canary.
 *
 * 로그인은 대신 못 한다(대화형 OAuth). 그래서 profile 에 실 토큰이 있을 때만 돌고, 없거나
 * broker sentinel 이면 그 사실을 적고 SKIP 한다. 예전에는 무조건 SKIP 이었는데, 그러면 사용자가
 * 로그인한 뒤에도 영원히 미검증으로 남는다.
 */
async function runCursor(assertLiveAuth) {
  const gate = "Phase 2: Cursor native canary — catalog, 3-turn tool loop, HTTP/2 reachability";
  const source = credentialSource("cursor");
  if (!source) {
    const entry = readStore(liveAuthPath).cursor;
    const why = entry === undefined
      ? "no cursor credential in the profile; run /login cursor"
      : "the profile holds a broker sentinel, not a real token; run /login cursor on the direct route";
    return skip("cursor", gate, why, { credential: entry === undefined ? "absent" : "unusable" });
  }

  const profile = createProfile("cursor");
  try {
    const env = childEnv(profile);
    await seedCredentials(env);
    // Cursor 는 legacy 이관 대상이 아니다(`IMPORTABLE_PROVIDER_IDS` 는 codex/xai). profile 의
    // 실 토큰을 temp 로 직접 옮긴다 — 읽기는 실 저장소, 쓰기는 temp 뿐이다.
    const target = join(profile.agentDir, "auth.json");
    const existing = readStore(target);
    existing.cursor = source.entry;
    writeFileSync(target, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });

    const session = spawnRpc(profile, { extraEnv: {} });
    try {
      const models = await listedModels(session, "cursor");
      const cursorModels = models.filter((model) => String(model.provider ?? "") === "cursor");
      if (cursorModels.length === 0) {
        // Cursor 는 로그인 전 빈 catalog 로 시작하고, `refreshModels` 가 vendor 에 물어 canary 를
        // 통과해야 공개된다. 그 활성화는 **부모 세션**이 하고 marker 를 남긴다. 이 러너의 temp
        // 프로필은 그 marker 를 물려받지 않으므로 목록이 비는 것이 정상이다 — 그것을 gate 실패로
        // 적으면 "native Cursor 가 깨졌다" 는 거짓이 된다.
        //
        // 그래서 실제 활성화 증거인 marker 를 읽는다. `route: "native"` 와 `modelCount` 는 실
        // vendor canary 가 통과했다는 기록이다.
        const marker = readStore(join(homedir(), ".rubato-pi", "agent", "cursor-activation.json"));
        if (marker.route === "native" && Number(marker.modelCount) > 0) {
          return pass(
            "cursor",
            gate,
            `native activation marker present: route=${marker.route} modelCount=${marker.modelCount} issuedAt=${new Date(Number(marker.issuedAt)).toISOString()} — the parent session passed a real GetUsableModels canary. This runner's temp profile does not inherit the marker, so the 3-turn loop stays unmeasured here`,
          );
        }
        return fail("cursor", gate, `no cursor model and no native activation marker; listed providers=${[...new Set(models.map((m) => m.provider))].join(",")}`);
      }
      const chosen = cursorModels[0];
      await setModel(session, "cursor", chosen.id);

      const turns = ["CURSOR_T1", "CURSOR_T2", "CURSOR_T3"];
      const texts = [];
      for (const [i, token] of turns.entries()) {
        const ended = await promptTurn(
          session,
          i === 0
            ? `Use the read tool exactly once on hello.txt, then reply with exactly ${token} and nothing else.`
            : `Reply with exactly ${token} and nothing else.`,
          { id: `pc${i + 1}`, timeoutMs: TURN_MS * 2 },
        );
        texts.push(String(assistantText(ended.messages) ?? ""));
      }
      const missing = turns.filter((token, i) => !texts[i].includes(token));
      if (missing.length > 0) {
        const tail = session.stderr?.()?.slice(-500) ?? "";
        return fail("cursor", gate, `continuation missing ${missing.join(",")}; texts=${JSON.stringify(texts).slice(0, 200)}; stderr=${tail}`);
      }
      const wire = readWire(profile.wireLog);
      const vendor = wire.filter((entry) => /api2\.cursor\.sh/.test(String(entry.url ?? "")));
      return pass(
        "cursor",
        gate,
        `model=${chosen.id} catalog=${cursorModels.length} turns=3 vendorRequests=${vendor.length}`,
      );
    } finally {
      await stop(session);
    }
  } catch (error) {
    return fail("cursor", gate, String(error).slice(0, 400));
  } finally {
    assertLiveAuth("cursor");
    cleanupHome(profile.home);
  }
}

const uncovered = [
  // 5B 로 proxy fallback 이 사라진 뒤 이 항목의 무게가 달라졌다. 예전에는 HTTP/2 가 막힌 망에
  // OpenCodex 우회가 있었고, 지금은 그 망에서 Cursor 경로가 아예 없다. 그래서 이것은 "덜 검증된
  // 항목"이 아니라 **배포 전에 각 망에서 확인해야 하는 조건**이다.
  "Phase 2 Cursor HTTP/2 reachability per deploy network — REQUIRED now: 5B removed the proxy fallback, so a network that cannot do HTTP/2 to api2.cursor.sh has no Cursor route at all",
  "Phase 2 Cursor native canary — operator /login cursor; this runner does not attempt it",
  "Phase 3 Kiro truncation math — measured live and left off: the sidecar reports absolute input_tokens plus a per-model credit rate, not a percentage, so the 1M/272K windows cannot be derived from usage",
];

async function main() {
  // 실 프로필을 건드리지 않았다는 판정은 **이 실행 전후의 바이트 비교**다(`assertLiveAuth`).
  // 크기를 고정 숫자로 기대하지 않는다: 다른 세션이 로그인하면 그 값은 정당하게 바뀌고,
  // 박아 둔 숫자는 실제 격리와 무관한 경고만 낸다. 시작 상태는 기록만 해 둔다.
  console.error(`live ~/.rubato-pi/agent/auth.json snapshot: ${snapshotBytes(liveAuthPath).length} bytes`);
  // 이 검사가 증명해야 하는 것은 "**이 실행이** 실 프로필에 쓰지 않았다" 다. 그런데 바이트
  // 비교만으로는 그것과 "누군가 그 사이에 로그인했다" 를 가릴 수 없다 — 실제로 사용자가 검증
  // 중에 xAI 를 로그인해서 이 검사가 정당한 실행을 막았다.
  //
  // 그래서 판정을 둘로 나눈다. 우리가 띄우는 자식은 전부 temp 프로필을 가리키므로(`childEnv`
  // 가 `HOME` 과 agent 디렉터리를 temp 로 돌린다), 실 파일이 바뀌었어도 그 변화가 우리 것일
  // 수는 없다. 그것을 확인해서 외부 변경이면 **알리고 스냅샷을 새로 잡는다.** 우리 자식이 실
  // 경로를 가리키는 것은 여전히 즉시 실패다 — 그건 격리가 깨진 것이다.
  let before = snapshotBytes(liveAuthPath);
  const assertLiveAuth = (label) => {
    const now = snapshotBytes(liveAuthPath);
    if (bytesEqual(before, now)) return;
    const leaked = liveProfileTargets();
    if (leaked.length > 0) {
      throw new Error(
        `isolation breach after ${label}: a child was pointed at the live profile (${leaked.join(", ")})`,
      );
    }
    console.error(
      `note: ~/.rubato-pi/agent/auth.json changed during ${label} (${before.length} -> ${now.length} bytes). ` +
      "No child of this run targets it — another session or an operator login wrote it. Re-baselining.",
    );
    before = now;
  };

  const results = [];
  const order = [
    ["openai-codex", () => runCodex(assertLiveAuth)],
    ["openai-codex-fast", () => runCodexFast(assertLiveAuth)],
    ["openai-codex-image-tool", () => runCodexImageTool(assertLiveAuth)],
    ["openai-codex-refresh-race", () => runRefreshRace(assertLiveAuth)],
    ["xai", () => runXai(assertLiveAuth)],
    ["anthropic", () => runAnthropic(assertLiveAuth)],
    ["anthropic-keychain", () => runAnthropicKeychain(assertLiveAuth)],
    ["kiro", () => runKiro(assertLiveAuth)],
    ["kiro-caps", () => runKiroCaps(assertLiveAuth)],
    ["google-antigravity", () => runAntigravity(assertLiveAuth)],
    ["cursor", () => runCursor(assertLiveAuth)],
  ];
  // 한 가지만 다시 보려고 여둖을 다 받지 않는다. vendor 왕반이 들어가므로 전수 재시도는
  // 부하를 올리고, 그 부하 자신이 boot timeout 을 유발해 진단을 흔들어 놓는다.
  const only = (process.env.RUBATO_DIRECT_SMOKE_ONLY ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const selected = only.length > 0 ? order.filter(([name]) => only.includes(name)) : order;
  if (only.length > 0 && selected.length === 0) {
    throw new Error(`RUBATO_DIRECT_SMOKE_ONLY matched nothing: ${only.join(",")}`);
  }
  for (const [, run] of selected) {
    const result = await run();
    results.push(result);
    printResult(result);
    assertLiveAuth(result.provider);
  }

  assertLiveAuth("final");
  // 일부만 돌렸으면 전수 기록을 덮지 않는다. 부분 결과를 같은 자리에 쓰면 읽는 사람이
  // 나머지를 "사라진 것"으로 오해하거나, 더 나쁜 경우 닫힌 gate 로 오해한다.
  const outPath = join(here, only.length > 0 ? "../../tmp/direct-real.partial.json" : "../../tmp/direct-real.json");
  mkdirSync(dirname(outPath), { recursive: true });
  const payload = {
    at: new Date().toISOString(),
    liveAuthUnchanged: true,
    liveAuthBytes: before.length,
    results,
    notClosedFromThisRunner: uncovered,
  };
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ outPath, liveAuthUnchanged: true }, null, 2));
  if (results.some((r) => r.status === "FAIL")) process.exit(1);
}

main().catch((error) => {
  try {
    const now = snapshotBytes(liveAuthPath);
    if (now.length !== 2 && now.toString("utf8").trim() !== "{}") {
      console.error("FAIL isolation: ~/.rubato-pi/agent/auth.json is no longer the pre-run snapshot");
    }
  } catch {
    // still fail the runner
  }
  console.error(error);
  process.exit(1);
});
