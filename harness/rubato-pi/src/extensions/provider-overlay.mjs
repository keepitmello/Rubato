import { builtinProviderIds, foreignProviderIds } from "../provider-ids.mjs";
export { builtinProviderIds, foreignProviderIds };
import { DIRECT_PROVIDER_IDS, directProviders, warnIgnoredDirectOptOut } from "../provider-direct.mjs";
import { importLegacyDirectCredentials, unavailableDirectProviders } from "../credential-import.mjs";
import { ANTIGRAVITY_ENDPOINT, loadAntigravityProjectId, registerAntigravityLifecycle } from "../antigravity-route.mjs";
import { importAntigravityKeychainCredential } from "../antigravity-keychain-import.mjs";
import { registerCursorExecNotice } from "../cursor-exec-notice.mjs";

/**
 * 보장된 경고 경로. `console.warn` 은 pinned host 에 반드시 있고, 테스트가 이 한 줄을
 * 관측한다. 값은 절대 싣지 않는다 — provider id 와 고정된 사유 어휘뿐이다.
 */
function warn(message) {
  console.warn(message);
}

/**
 * 등록할 provider. FX bridge 삭제 뒤 **유일한** 경로이므로 native 직결 목록이 그대로
 * 제품 catalog 다.
 *
 * 이름이 `brokerProviders` 였을 때와 역할이 다르다. 예전에는 bridge catalog 를
 * `/coding-agent/v1/models` 에서 받아 FX transport provider 를 합성했고, native 는 그
 * 위를 덮는 두 번째 등록이었다. 이제 합성할 catalog 도, 덮을 대상도 없다 — pinned pi-ai
 * factory 가 모델 metadata 의 유일한 권위다.
 */
export async function supportedProviders({ env = process.env, antigravity, cursor } = {}) {
  return await directProviders({
    env,
    ...(antigravity ? { antigravity } : {}),
    ...(cursor ? { cursor } : {}),
  });
}

/**
 * provider 등록 extension.
 *
 * 한 extension 이 두 경로를 다 안다. 나누면 부모와 격리 agent 가 서로 다른 조합을
 * 받을 수 있고, 그때 어느 세션이 어느 경로였는지 되짚을 수 없다.
 *
 * 등록 순서가 계약이다:
 *   1. native provider 를 등록한다.
 *   2. 그 뒤에 foreign 정리를 한다.
 *
 * 순서의 근거는 pinned `model-runtime.js:635-640` 이다: 같은 id 에 대해 **마지막
 * 등록이 이긴다**. 정리를 등록보다 먼저 하면 방금 등록한 native 가 사라진다.
 *
 * FX bridge 삭제 전에는 0번 단계로 bridge catalog provider 를 전부 등록하고 native 가
 * 그 위를 덮었다. 그 단계가 없어졌다 — 덮을 대상도, 받아올 catalog 도 없다.
 */
/**
 * 이 프로세스가 부모 세션인가.
 *
 * 부모는 `lead-overlay.mjs` 를 싣고 격리 자식은 provider overlay 만 싣는다 —
 * `extensions/adapter.mjs` 가 이미 같은 신호로 부모를 가른다. 새 판별자를 만들지 않고
 * 그것을 따른다: 두 개가 되면 언젠가 서로 어긋난다.
 */
function parentSession(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === "-e" || argv[i] === "--extension") && argv[i + 1]?.endsWith("lead-overlay.mjs")) {
      return true;
    }
  }
  return false;
}

export default async function providerOverlay(pi, {
  env = process.env,
  antigravityCredentialImporter = importAntigravityKeychainCredential,
  antigravityProjectLoader = loadAntigravityProjectId,
  fetchImpl = globalThis.fetch,
} = {}) {
  // 직결은 조건이 아니다. bridge 가 없으므로 이것이 유일한 경로이고, 여기서 갈라지면
  // provider 가 하나도 없는 세션이 뜬다. 예전 opt-out 값을 들고 온 환경에는 한 줄
  // 경고만 내고 같은 경로로 간다.
  warnIgnoredDirectOptOut(env, warn);
  // `env` 를 넘긴다. 넘기지 않으면 native 층이 `process.env` 를 다시 읽고, 격리된
  // 세션(별도 profile, 별도 gate)이 그 지점에서 깨진다.
  const antigravity = {};
  const natives = await supportedProviders({
    env,
    antigravity,
    cursor: { reactivateOnCredentialRotation: parentSession(process.argv) },
  });
  // 이관 결과를 삼키지 않는다. pinned ExtensionAPI 에는 `log` 가 없어서(agent-session.js
  // 의 extension 객체를 확인했다) `pi.log?.()` 는 영원히 조용한 no-op 이 된다. 그래서
  // 관측 가능한 두 경로만 쓴다: 이관이 **필요한데** 입력이 깨져 막힌 경우는 던지고,
  // 이관이 필요 없는 경우는 보장된 경고 한 줄을 낸다. 값은 어느 쪽에도 싣지 않는다.
  const report = await importLegacyDirectCredentials({ env });
  const rejectedIds = Object.keys(report.rejected ?? {});
  // provider 단위로 묻는다. Codex 가 멀쩡하다고 xAI 의 부재가 덮이면, 그 세션은
  // 부팅은 성공하고 첫 xAI 요청에서 죽는다.
  const unavailable = await unavailableDirectProviders(report, env);
  // legacy/대상이 깨져서 못 채운 것만 부팅을 막는다. 그냥 로그인을 안 한 상태
  // (`absent`)는 정상이며, 로그인 흐름이 그것을 해결한다.
  const blocking = unavailable.filter((entry) => entry.reason !== "absent");
  if (blocking.length > 0) {
    throw new Error(
      "provider-overlay: cannot use " +
      `${blocking.map((entry) => `${entry.id}(${entry.reason})`).join(" ")}: ` +
      "the legacy store could not be used and the target has no valid credential for it. " +
      "Log in again.",
    );
  }
  // 기존 Codex/xAI 진단이 먼저다. 같은 target 이 깨졌을 때 Antigravity 이관이
  // 그 오류를 가리면 사용자는 원래 부팅 blocker 를 보지 못한다.
  //
  // **이관은 부모만 한다.** 격리 memory/reflection 자식도 같은 overlay 를 물려받으므로
  // (`brand.mjs` 가 provider extension 경로를 자식에 싣는다) 걸지 않으면 자식마다 Keychain
  // 을 읽고 `loadCodeAssist` 로 Google 에 요청한다 — 시작 부작용이 자식 수만큼 곱해진다.
  // 대상에 이미 있으면 `already_present` 로 즉시 끝나므로 로그인된 기기에서는 값이 싸지만,
  // 로그인 전에는 자식이 각자 네트워크를 때린다. 권위를 가진 쪽 하나만 이관한다.
  const antigravityEndpoint = env.RUBATO_ANTIGRAVITY_ENDPOINT || ANTIGRAVITY_ENDPOINT;
  const antigravityReport = await antigravityCredentialImporter({
    env,
    enabled: parentSession(process.argv),
    resolveProjectId: (token, { signal }) => antigravityProjectLoader(token.access, antigravityEndpoint, fetchImpl, signal),
  });
  if (["target_invalid_json", "target_not_an_object", "target_rejected_by_engine", "rejected"].includes(antigravityReport.status)) {
    throw new Error(
      `provider-overlay: Antigravity credential import failed (${antigravityReport.status}` +
      `${antigravityReport.reason ? `:${antigravityReport.reason}` : ""})`,
    );
  }
  const degraded = report.status !== "imported" && report.status !== "nothing_to_import" && report.status !== "legacy_absent";
  if (degraded || rejectedIds.length > 0) {
    warn(
      `provider-overlay: legacy credential import incomplete (status=${report.status}` +
      `${rejectedIds.length > 0 ? `, rejected=${rejectedIds.map((id) => `${id}:${report.rejected[id]}`).join(" ")}` : ""})`,
    );
  }

  // 1) native 등록. `DIRECT_PROVIDER_IDS` 밖의 provider 는 손대지 않는다.
  for (const provider of natives) {
    if (!DIRECT_PROVIDER_IDS.includes(provider.id)) continue;
    pi.registerProvider(provider);
  }
  if (antigravity.stateStore && antigravity.lineage) {
    registerAntigravityLifecycle(pi, { ...antigravity, env });
  }
  // 지난 세션이 남긴 `unknown` server-driven tool call 을 세션 시작에 한 번 알린다.
  // journal 을 읽기만 한다 — 단일 owner 는 `cursor-exec-bridge` 다.
  registerCursorExecNotice(pi);

  // 2) foreign 정리. 지원 신원(`SUPPORTED_PROVIDER_IDS`)이 권위다.
  for (const id of foreignProviderIds(builtinProviderIds())) {
    // 직결로 등록한 id 를 다시 지우면 방금 등록한 native 가 사라진다.
    if (DIRECT_PROVIDER_IDS.includes(id)) continue;
    try {
      pi.unregisterProvider(id);
    } catch {
      // A provider the host refuses to drop stays visible; never fail the overlay over it.
    }
  }
}
