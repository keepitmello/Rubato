import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_RETENTION } from "./defaults.mjs";
import { applyChildExtensionsEnv } from "./runtime-env.mjs";

export const BRAND_NAME = "\u{1D493}\u{1D496}\u{1D483}\u{1D482}\u{1D495}\u{1D490}";
export const BRAND_ASCII = "rubato";
export const RUBATO_VERSION = "0.0.5";
export const CONFIG_DIR_NAME = ".rubato-pi";
export const ENV_PREFIX = "RUBATO_PI";

function resolveRubatoVersion(env) {
  const override = env?.RUBATO_VERSION;
  return typeof override === "string" && override.trim() ? override.trim() : RUBATO_VERSION;
}

export function brandProfile(env) {
  return {
    name: BRAND_NAME,
    displayVersion: resolveRubatoVersion(env),
    configDir: CONFIG_DIR_NAME,
    flatLayout: false,
    envPrefix: ENV_PREFIX,
    userAgent: BRAND_ASCII,
    originator: BRAND_ASCII,
  };
}

export function defaultAgentDir(home = homedir()) {
  return join(home, CONFIG_DIR_NAME, "agent");
}

/**
 * 모델 프로바이더를 등록하는 확장. 우리 프로바이더는 `models.json` 에 없다 —
 * provider-overlay 가 부팅 때 provider 를 직접 등록한다(`providers: {}` 인 이유).
 *
 * 그래서 확장 없이 뜨는 자식 프로세스는 pi-ai 빌트인 프로바이더만 갖고, 자격증명 없이
 * 벤더 API 를 직접 때려 401 로 죽는다. 실제로 reflection·dream·facts 배경 에이전트이
 * 전부 그렇게 죽고 있었다 — 부모 세션은 `-e provider-overlay` 로 멀쩡했으므로 증상이
 * 자식 쪽에만 보였다.
 *
 * `--no-extensions` 는 **탐색만** 끄고 명시적 `-e` 는 그대로 싣는다(senpi
 * core/resource-loader.js 의 noExtensions 분기). 그래서 자식의 가벼운 격리를 유지한
 * 채로 프로바이더만 되돌려 줄 수 있다.
 *
 * 목록을 env 로 넘기는 이유: 이 경로는 하네스가 아는 것이고 packages/ 쪽은
 * 몰라야 한다. 값이 없으면 packages 는 예전 argv 그대로 만든다.
 *
 * 여기에 lead-overlay/adapter 는 넣지 않는다. 그것들은 Rubato 컴포넌트·태스크 엔진·
 * statusline 을 자식에 다시 깔아서 `--no-extensions` 로 산 격리를 도로 무른다.
 */
export function providerExtensionPaths() {
  return [fileURLToPath(new URL("./extensions/provider-overlay.mjs", import.meta.url))];
}

/**
 * `RUBATO_MEASUREMENT_LOG=<path>` is the low-level toggle the recorder itself checks
 * (measurement-recorder.mjs `enabled()`) and stays the way to route measurements to a
 * chosen file, e.g. from run-measurement-benchmarks.mjs. For everyday interactive use,
 * nobody wants to construct a path by hand, so `RUBATO_MEASUREMENT=1` picks one under the
 * agent profile dir when RUBATO_MEASUREMENT_LOG was not already set explicitly.
 * Recording defaults OFF: neither var set means measurementRecorder() stays a no-op, so a
 * normal session pays nothing (measured: contextSegments() on an ~870KB context costs under
 * 1ms, appendFileSync for a ~1MB event line under 0.7ms).
 */
export function defaultMeasurementLogPath(agentDir, { now = () => new Date(), pid = process.pid } = {}) {
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  return join(agentDir, "measurements", `${stamp}-${pid}.jsonl`);
}

export function launchEnv(baseEnv, agentDir) {
  const env = { ...baseEnv };
  env.RUBATO_VERSION = resolveRubatoVersion(env);
  env.SENPI_BRAND = JSON.stringify(brandProfile(env));
  env.SENPI_CODING_AGENT_DIR = agentDir;
  env.RUBATO_PI_CODING_AGENT_DIR = agentDir;
  // provider SDK의 범용 추적 비활성화 계약이다.
  env.DO_NOT_TRACK = "1";
  applyChildExtensionsEnv(env, providerExtensionPaths(), delimiter);
  // canonical 이름 하나만 아이에게 넘긴다. 예전 `FX_CACHE_RETENTION` 은 FX bridge
  // config 만 읽었고, 그 bridge 는 없다.
  env.PI_CACHE_RETENTION = env.PI_CACHE_RETENTION ?? CACHE_RETENTION;
  if (env.RUBATO_MEASUREMENT === "1" && !env.RUBATO_MEASUREMENT_LOG) {
    env.RUBATO_MEASUREMENT_LOG = defaultMeasurementLogPath(agentDir);
  }
  return env;
}
