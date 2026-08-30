// legacy 자격증명을 직결 경로의 권위 저장소로 한 번만 옮긴다.
//
// bridge 는 `~/.senpi/agent/auth.json` 을 읽었다. 직결 provider 는 브랜드 profile 의
// `~/.rubato-pi/agent/auth.json` 을 권위로 쓴다. 그래서 직결을 처음 켜는 세션은
// 로그인 화면을 다시 만나게 되는데, 같은 계정의 같은 token 이 옆 파일에 이미 있다.
//
// 이 파일이 하는 일은 그 한 번의 이동뿐이다. 상시 동기화가 아니다 — 두 저장소가
// 서로를 계속 덮으면 refresh writer 가 둘이 되고, 어느 쪽이 최신인지 알 수 없게 된다.
//
// **덮어쓰지 않는다.** 대상에 그 provider 가 이미 있으면 건드리지 않는다.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { senpiDir } from "./engine-paths.mjs";

/** 이관 대상. 직결로 보내는 provider 만 옮긴다. */
export const IMPORTABLE_PROVIDER_IDS = Object.freeze(["openai-codex", "xai"]);

/**
 * 테스트가 살아 있는 자격증명 저장소를 쓰는 것을 막는다.
 *
 * FX bridge 를 지우기 전에는 이 경로가 `RUBATO_PROVIDER_DIRECT=1` 뒤에 숨어 있어서,
 * 플래그를 주지 않은 테스트는 legacy auth 를 아예 읽지 않았다. 직결이 유일한 경로가
 * 되면서 그 자연스러운 방벽이 사라졌다 — 이제 `env` 를 안 넘긴 테스트는 기본값으로
 * 실제 `~/.senpi` 와 `~/.rubato-pi` 를 집는다. 그 둘은 이 기기의 다른 세션들이
 * 지금 쓰고 있는 파일이다.
 *
 * 삭제된 `broker.mjs` 가 같은 이유로 `ensureBroker.isUp` 주입을 강제했다. 같은 규칙을
 * 여기에 둔다: 테스트 안에서는 경로를 **명시**해야 한다.
 */
function refuseLiveCredentialStoreFromTests(legacyPath, targetPath) {
  const inTest = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes("--test");
  if (!inTest) return;
  // 판정은 **해결된 경로**로 한다. 어느 env 이름으로 격리했는지는 묻지 않는다 —
  // `SENPI_CODING_AGENT_DIR` 로 agent 디렉터리를 옮긴 테스트도 똑같이 안전하다.
  const home = homedir();
  const live = [defaultLegacyAuthPath(home), join(home, ".rubato-pi", "agent", "auth.json")];
  const touched = [legacyPath, targetPath].filter((path) => live.includes(path));
  if (touched.length === 0) return;
  throw new Error(
    `tests must not use the live credential store (${touched.join(" ")}); ` +
    "inject RUBATO_LEGACY_AUTH_PATH / RUBATO_TARGET_AUTH_PATH or a custom agent dir",
  );
}

export function defaultLegacyAuthPath(home = homedir()) {
  return join(home, ".senpi", "agent", "auth.json");
}

/**
 * 이관 대상이 될 `auth.json` 경로.
 *
 * 홈 아래 고정 경로를 쓰면 안 된다. spawn 된 Senpi 는 `*_CODING_AGENT_DIR` 로 agent
 * 디렉터리를 옮길 수 있고(`brand.mjs` 의 `launchEnv` 가 실제로 넘긴다), native
 * AuthStorage 는 **그 해결된 디렉터리**에 쓴다(`config.js:446-459,478`). 우리가 홈에
 * 쓰면 세션이 읽지 않는 파일을 채우고, 로그인은 여전히 비어 있는 것으로 보인다.
 *
 * 우선순위는 pinned 동작과 같은 순서다:
 *   1. 명시적 `RUBATO_TARGET_AUTH_PATH` (테스트와 운영자 override)
 *   2. `*_CODING_AGENT_DIR` — brand prefix 와 legacy prefix 를 pinned 와 같은 순서로 본다
 *   3. 브랜드 profile 기본 경로
 *
 * `~` 는 pinned `normalizePath` 와 같게 **실제 homedir** 로 펼친다. `env.HOME` 을
 * 홈으로 취급하지 않는다 — pinned 가 그렇게 하지 않으므로, 그렇게 하면 테스트만
 * 통과하고 실제 세션은 다른 파일을 본다.
 */
const AGENT_DIR_ENV_NAMES = Object.freeze([
  "RUBATO_PI_CODING_AGENT_DIR",
  "SENPI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
]);

function expandHome(value, home = homedir()) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return value;
}

export function resolveAgentDirFromEnv(env = process.env, home = homedir()) {
  for (const name of AGENT_DIR_ENV_NAMES) {
    const value = env?.[name];
    // pinned `envValue` 는 **정의된** 첫 값을 쓴다. 빈 문자열도 뒤 prefix 를
    // 가리는 명시 값이고, `resolveAgentDir` 에서는 profile 기본값으로 정착한다.
    if (value !== undefined) return typeof value === "string" && value.length > 0 ? expandHome(value, home) : undefined;
  }
  return undefined;
}

export function defaultTargetAuthPath(home = homedir(), env = process.env) {
  const agentDir = resolveAgentDirFromEnv(env, home);
  if (agentDir) return join(agentDir, "auth.json");
  return join(home, ".rubato-pi", "agent", "auth.json");
}

/**
 * 자격증명 한 항목을 **pinned Senpi 파서**로 검증한다.
 *
 * 손으로 다시 쓰지 않는다. 직접 만든 검사는 pinned `ReadOnlyAuthStorage.load()` 보다
 * 느슨해지기 쉽고, 그러면 엔진이 나중에 거절할 항목을 우리가 옮겨 놓는다 — 대상
 * auth.json 이 통째로 `Invalid auth.json` 이 되어 **다른 provider 까지** 못 읽는다.
 * pinned 계약은 정확히 이렇다:
 *   - `api_key`: `key` 는 string 이거나 아예 없어도 되고, `env` 는 string map 이면 된다
 *   - `oauth`: `access`, `refresh` 가 string 이고 `expires` 가 유한한 number 여야 한다
 *
 * `load()` 는 파일 전체를 보고 **첫 번째** 잘못된 항목에서 throw 한다. 그래서 항목을
 * 하나씩 단독으로 태워 검증한다 — 그러지 않으면 관계없는 provider(예: anthropic) 하나가
 * 깨져 있을 때 멀쩡한 Codex/xAI 이관까지 막힌다.
 */
async function loadReadOnlyStorage() {
  const module = await import(pathToFileURL(join(senpiDir, "dist/core/auth-storage.js")).href);
  if (typeof module.ReadOnlyAuthStorage !== "function") {
    throw new Error("pinned senpi has no ReadOnlyAuthStorage");
  }
  return module.ReadOnlyAuthStorage;
}

/**
 * 항목 하나를 pinned 파서에 태운다. 통과하면 `{ ok: true }`.
 *
 * 검증은 임시 파일 하나에 그 항목만 담아 수행한다. 값은 반환하지 않는다 — 사유만.
 */
export function credentialShapeWith(ReadOnlyAuthStorage, providerId, entry, { dir } = {}) {
  const probeDir = dir ?? mkdtempSync(join(tmpdir(), "rubato-cred-probe-"));
  const probePath = join(probeDir, "probe-auth.json");
  try {
    writeFileSync(probePath, JSON.stringify({ [providerId]: entry }), { encoding: "utf-8", mode: 0o600 });
    new ReadOnlyAuthStorage(probePath).load();
    return { ok: true, type: entry?.type };
  } catch (error) {
    // pinned 메시지는 provider id 만 담는다(값은 담지 않는다). 그래도 우리 쪽에서
    // 다시 한 번 좁혀서, 사유를 고정된 어휘로만 보고한다.
    return { ok: false, reason: describeRejection(entry) };
  } finally {
    rmSync(probePath, { force: true });
    if (!dir) rmSync(probeDir, { recursive: true, force: true });
  }
}

/**
 * 파일 전체를 pinned 파서에 태운다. 항목 하나가 아니라 파일 단위 계약을 본다.
 */
export function credentialFileShapeWith(ReadOnlyAuthStorage, contents) {
  const probeDir = mkdtempSync(join(tmpdir(), "rubato-cred-file-"));
  const probePath = join(probeDir, "probe-auth.json");
  try {
    writeFileSync(probePath, contents, { encoding: "utf-8", mode: 0o600 });
    new ReadOnlyAuthStorage(probePath).load();
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

/**
 * 거절 사유를 값 없이 설명한다. pinned 파서가 거절한 뒤에만 부른다 —
 * 판정의 권위는 파서이고, 이것은 사람이 읽을 이름을 붙이는 일만 한다.
 */
function describeRejection(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "not_an_object";
  const type = entry.type;
  if (type === undefined) return "missing_type";
  if (type === "api_key") {
    if (entry.key !== undefined && typeof entry.key !== "string") return "api_key_key_not_a_string";
    return "api_key_env_not_a_string_map";
  }
  if (type === "oauth") {
    if (typeof entry.access !== "string") return "oauth_missing_access";
    if (typeof entry.refresh !== "string") return "oauth_missing_refresh";
    if (entry.expires === undefined) return "oauth_missing_expires";
    if (typeof entry.expires !== "number") return "oauth_expires_not_a_number";
    if (!Number.isFinite(entry.expires)) return "oauth_expires_not_finite";
    return "oauth_invalid";
  }
  return "unsupported_type";
}

/**
 * legacy 파일을 읽고 옮길 후보만 남긴다. 대상 파일은 아직 열지 않는다.
 *
 * 반환하는 status 에 값은 없다. provider id, 자격증명 종류, 거절 사유뿐이다.
 */
export async function readLegacyCandidates(legacyPath, { read = readFileSync, ReadOnlyAuthStorage } = {}) {
  const Parser = ReadOnlyAuthStorage ?? (await loadReadOnlyStorage());
  let raw;
  try {
    raw = read(legacyPath, "utf-8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    return { candidates: {}, status: code === "ENOENT" ? "legacy_absent" : "legacy_unreadable", rejected: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 깨진 legacy 파일은 대상을 건드리지 않고 여기서 멈춘다.
    return { candidates: {}, status: "legacy_invalid_json", rejected: {} };
  }
  if (!parsed || typeof parsed !== "object") {
    return { candidates: {}, status: "legacy_invalid_json", rejected: {} };
  }
  const candidates = {};
  const rejected = {};
  // 항목마다 단독으로 태운다. pinned load() 는 첫 실패에서 멈추므로, 통째로 태우면
  // 관계없는 provider 하나 때문에 멀쩡한 이관이 막힌다.
  const probeDir = mkdtempSync(join(tmpdir(), "rubato-cred-probe-"));
  try {
    for (const id of IMPORTABLE_PROVIDER_IDS) {
      if (!(id in parsed)) continue;
      const shape = credentialShapeWith(Parser, id, parsed[id], { dir: probeDir });
      if (shape.ok) candidates[id] = parsed[id];
      else rejected[id] = shape.reason;
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  return { candidates, status: "legacy_read", rejected };
}

async function loadBackend() {
  const module = await import(pathToFileURL(join(senpiDir, "dist/core/auth-storage.js")).href);
  if (typeof module.FileAuthStorageBackend !== "function") {
    throw new Error("pinned senpi has no FileAuthStorageBackend");
  }
  return module.FileAuthStorageBackend;
}

/**
 * legacy 항목을 대상으로 옮긴다. 이미 있는 provider 는 절대 덮지 않는다.
 *
 * 병합은 **대상 lock 안에서 한 번**에 한다. `get()` 으로 보고 `set()` 으로 쓰면
 * 그 사이에 다른 프로세스가 로그인해 넣은 값을 덮는다 — 확인과 쓰기가 갈라지는 순간
 * 그 창이 열린다. 그래서 lock 안에서 현재 JSON 을 다시 parse 하고, 그 시점에도
 * 없는 key 만 채운 다음, next JSON 하나를 돌려준다. 쓰기는 patch 된 atomic 경로가
 * 수행한다(temp → fsync → rename → dir fsync, mode 0600).
 */
export async function importLegacyDirectCredentials(options = {}) {
  const {
    env = process.env,
    legacyPath = env?.RUBATO_LEGACY_AUTH_PATH ?? defaultLegacyAuthPath(),
    targetPath = env?.RUBATO_TARGET_AUTH_PATH ?? defaultTargetAuthPath(homedir(), env),
    read = readFileSync,
    backendFactory,
    ReadOnlyAuthStorage,
  } = options;
  refuseLiveCredentialStoreFromTests(legacyPath, targetPath);
  if (legacyPath === targetPath) return { status: "same_path", imported: [], skipped: [], rejected: {} };

  // 1) legacy 를 먼저 읽고 검증한다. 대상 lock 을 잡기 전이다.
  const { candidates, status, rejected } = await readLegacyCandidates(legacyPath, { read, ReadOnlyAuthStorage });
  const candidateIds = Object.keys(candidates);
  if (candidateIds.length === 0) {
    return { status, imported: [], skipped: [], rejected };
  }

  // 2) 대상 lock 안에서 한 번에 병합한다.
  const Parser = ReadOnlyAuthStorage ?? (await loadReadOnlyStorage());
  const Backend = backendFactory ?? (await loadBackend());
  const backend = new Backend(targetPath);
  const imported = [];
  const skipped = [];
  let targetStatus = "target_ok";
  await backend.withLockAsync(async (current) => {
    let data = {};
    if (typeof current === "string" && current.trim().length > 0) {
      let parsed;
      try {
        parsed = JSON.parse(current);
      } catch {
        // 대상이 깨져 있으면 아무것도 쓰지 않는다. 덮어쓰면 남은 것마저 잃는다.
        targetStatus = "target_invalid_json";
        skipped.push(...candidateIds);
        return { result: undefined };
      }
      // 배열은 `typeof === "object"` 를 통과한다. 그대로 spread 하면 인덱스가 key 가 되어
      // `{"0": …}` 짜리 auth.json 을 만든다 — provider 이름이 사라진 파일이다.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        targetStatus = "target_not_an_object";
        skipped.push(...candidateIds);
        return { result: undefined };
      }
      // 그리고 대상 **전체**를 pinned 파서에 태운다. 한 항목이라도 엔진 계약을 어기면
      // 엔진은 이 파일을 통째로 거절한다. 그 위에 새 항목을 얹으면 우리가 그 상태를
      // 굳히는 셈이므로, 손대지 않고 사유만 보고한다.
      const targetShape = credentialFileShapeWith(Parser, current);
      if (!targetShape.ok) {
        targetStatus = "target_rejected_by_engine";
        skipped.push(...candidateIds);
        return { result: undefined };
      }
      data = parsed;
    }
    const next = { ...data };
    for (const id of candidateIds) {
      // lock 안에서 다시 본다. legacy 를 읽은 뒤 방금 로그인한 값이 여기 있을 수 있고,
      // 그 값이 이긴다.
      if (id in next) {
        skipped.push(id);
        continue;
      }
      next[id] = candidates[id];
      imported.push(id);
    }
    if (imported.length === 0) return { result: undefined };
    return { result: undefined, next: JSON.stringify(next, null, 2) };
  });

  return {
    targetStatus,
    status: imported.length > 0
      ? "imported"
      : targetStatus !== "target_ok" ? targetStatus : "nothing_to_import",
    imported,
    skipped,
    rejected,
  };
}

/**
 * 대상에 **어느** 직결 provider 자격증명이 유효하게 들어 있는지 돌려준다.
 *
 * 예전에는 `.some()` 으로 "하나라도 있으면 있음"을 답했다. 그러면 Codex 만 있고 xAI 는
 * 없는 대상에서 legacy 가 깨졌을 때, xAI 는 여전히 이관이 필요한데도 경고만 내고 지나갔다.
 * 질문은 provider 단위이므로 답도 provider 단위여야 한다.
 *
 * 판정은 pinned 파서로 한다. 배열이나 깨진 대상은 "없음"이다 — 엔진이 읽지 못하는 파일에
 * 들어 있는 것은 있는 것이 아니다.
 */
export async function presentDirectCredentials(env = process.env, {
  targetPath = env?.RUBATO_TARGET_AUTH_PATH ?? defaultTargetAuthPath(homedir(), env),
  read = readFileSync,
  ReadOnlyAuthStorage,
} = {}) {
  const Parser = ReadOnlyAuthStorage ?? (await loadReadOnlyStorage());
  let raw;
  try {
    raw = read(targetPath, "utf-8");
  } catch {
    return new Set();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();

  const present = new Set();
  const probeDir = mkdtempSync(join(tmpdir(), "rubato-cred-present-"));
  try {
    for (const id of IMPORTABLE_PROVIDER_IDS) {
      if (!(id in parsed)) continue;
      // 항목별로 태운다. 관계없는 provider 가 깨져 있어도 이 provider 의 존재 판정은
      // 그것과 무관하다.
      if (credentialShapeWith(Parser, id, parsed[id], { dir: probeDir }).ok) present.add(id);
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  return present;
}

/**
 * 직결을 켜기 전에 각 provider 가 쓸 수 있는 상태인지 판정한다.
 *
 * 막는 조건은 provider 단위다: 대상에 없고, legacy 로도 채울 수 없는 id 가 하나라도 있으면
 * 그 id 를 이름으로 들어 세운다. 한 provider 가 멀쩡하다고 다른 provider 의 부재를 덮지 않는다.
 */
export async function unavailableDirectProviders(report, env = process.env, options = {}) {
  const present = await presentDirectCredentials(env, options);
  const imported = new Set(report?.imported ?? []);
  const rejected = report?.rejected ?? {};
  const legacyBroken = report?.status === "legacy_unreadable" || report?.status === "legacy_invalid_json";
  const targetBroken = report?.targetStatus !== undefined && report.targetStatus !== "target_ok";

  const unavailable = [];
  for (const id of IMPORTABLE_PROVIDER_IDS) {
    if (present.has(id) || imported.has(id)) continue;
    if (rejected[id]) unavailable.push({ id, reason: rejected[id] });
    else if (legacyBroken) unavailable.push({ id, reason: report.status });
    else if (targetBroken) unavailable.push({ id, reason: report.targetStatus });
    else unavailable.push({ id, reason: "absent" });
  }
  return unavailable;
}
