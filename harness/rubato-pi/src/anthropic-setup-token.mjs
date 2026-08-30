// Claude 장기 setup-token 을 직결 Anthropic provider 의 **마지막** 자격증명 출처로 덧댄다.
//
// 이 파일이 하는 일은 하나다: pinned `anthropicProvider()` 의 `auth.apiKey.resolve` 가
// 아무것도 찾지 못했을 때, `~/.claude/auth/setup-token-<계정>` 또는 macOS Keychain 에서
// `sk-ant-oat…` 를 읽어 **apiKey 로** 돌려준다.
//
// 왜 apiKey 인가. pinned anthropic-messages 는 apiKey 가 `sk-ant-oat` 를 포함할 때만
// OAuth 경로를 탄다(`api/anthropic-messages.js:1396-1397,1447`). 그 경로가 Claude CLI
// 신원 전체를 붙인다 — `user-agent: claude-cli/2.1.75`, `anthropic-beta:
// claude-code-20250219,oauth-2025-04-20`, `x-app: cli`, Claude Code system prompt,
// 그리고 tool 이름의 canonical 대소문자 교정(`toClaudeCodeName`). 그래서 우리가 할 일은
// **token 을 그 자리에 놓는 것**뿐이고, 신원·beta·cache 의미는 전부 pin 이 소유한다.
//
// bridge 는 로컬 Claude 설치의 symlink 를 읽어 user-agent 를 직접 만들었다. 직결은 그
// 동작을 가져오지 않는다 — pinned 판이 권위이고, 그 차이는 설계가 wire gate 에서
// Anthropic setup-token은 OAuth 호환 credential resolver 입력으로만 수용한다.
//
// **token 을 복사하지 않는다.** 읽어서 메모리로만 넘긴다. Rubato AuthStorage 로 옮기는
// 이관 경로는 없다 — 그것을 하면 setup-token 이 두 곳에 살고, 우리가 갱신하지 않는
// 값을 우리가 소유한 것처럼 보이게 된다.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * setup-token 의 접두. 이것으로 시작하지 않는 값은 setup-token 이 아니다.
 *
 * 검사를 생략하면 안 된다: 접두가 다른 값을 apiKey 로 넘기면 pinned 판정이 OAuth 가
 * 아니라 x-api-key 경로를 골라, Claude Code 신원 없이 조용히 다른 요청이 나간다.
 */
export const CLAUDE_SETUP_TOKEN_PREFIX = "sk-ant-oat";

/** Keychain service 이름. `security -s` 로 찾는 그 값이다. */
export function claudeSetupTokenService(account) {
  return `Claude Code-setup-token-${account}`;
}

/**
 * Rubato 가 소유하는 env 이름. **이쪽이 canonical 이다.**
 *
 * legacy `FX_*` 이름은 install.sh / rubato-auth.sh 가 아직 쓰고 있어서 같은 기기에서
 * 두 이름이 공존한다. 그래서 읽기는 하되 **낮은 우선순위**로만 받고, 새 문서·새
 * 런타임 계약에는 `RUBATO_*` 만 적는다. 우선순위는 아래 resolver 가 한 곳에서
 * 결정하고 테스트가 그 순서를 고정한다 — 두 이름이 각자 흩어지면 어느 쪽이 이겼는지
 * 나중에 되짚을 수 없다.
 */
export const CLAUDE_ACCOUNT_ENV = "RUBATO_CLAUDE_ACCOUNT";
export const CLAUDE_SETUP_TOKEN_FILE_ENV = "RUBATO_CLAUDE_SETUP_TOKEN_FILE";
/** @deprecated bridge 시절 이름. 새 문서에는 적지 않는다. */
export const LEGACY_CLAUDE_ACCOUNT_ENV = "FX_CLAUDE_ACCOUNT";
/** @deprecated bridge 시절 이름. 새 문서에는 적지 않는다. */
export const LEGACY_CLAUDE_SETUP_TOKEN_FILE_ENV = "FX_CLAUDE_SETUP_TOKEN_FILE";

/** 계정 기본값. bridge·install.sh·rubato-auth.sh 가 모두 이 값을 쓴다. */
export const DEFAULT_CLAUDE_ACCOUNT = "sub";

function envValue(env, ...names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function claudeAccount(env = process.env) {
  return envValue(env, CLAUDE_ACCOUNT_ENV, LEGACY_CLAUDE_ACCOUNT_ENV) ?? DEFAULT_CLAUDE_ACCOUNT;
}

export function claudeSetupTokenPath(env = process.env, home = homedir()) {
  return (
    envValue(env, CLAUDE_SETUP_TOKEN_FILE_ENV, LEGACY_CLAUDE_SETUP_TOKEN_FILE_ENV) ??
    join(home, ".claude", "auth", `setup-token-${claudeAccount(env)}`)
  );
}

/** 값을 싣지 않는 출처 어휘. 이 두 문자열만 auth status 에 노출된다. */
export const CLAUDE_SETUP_TOKEN_SOURCES = Object.freeze({
  file: "Claude setup-token file",
  keychain: "Claude setup-token Keychain",
});

function validToken(text) {
  const token = typeof text === "string" ? text.trim() : "";
  return token.startsWith(CLAUDE_SETUP_TOKEN_PREFIX) && token.length > CLAUDE_SETUP_TOKEN_PREFIX.length
    ? token
    : undefined;
}

/**
 * **취소는 부재가 아니다.**
 *
 * 이 구분이 이 파일의 핵심 계약이다. "없음"(`undefined`)은 "이 기기에 setup-token 이
 * 없다"는 사실이고, 호출자는 그것을 보고 다음 출처로 넘어가거나 조용히 포기한다.
 * 취소는 사실이 아니라 **판정 중단**이다 — 우리는 답을 모른다.
 *
 * 취소를 `undefined` 로 접으면 두 가지가 동시에 깨진다. pinned resolver 는 취소를
 * 정착시키지 못하고 "자격증명 없음"으로 계속 진행하고(취소된 요청이 auth 오류로
 * 끝난다), 버려진 자격증명 작업은 그대로 돌아 Keychain 조회와 파일 읽기가 살아남는다.
 * 그래서 취소는 **반드시 다시 던진다**.
 */
function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

/** 취소 사유. signal 이 준 이유를 그대로 쓰고, 없으면 표준 AbortError 를 만든다. */
function abortReason(signal, error) {
  if (signal?.aborted && signal.reason !== undefined) return signal.reason;
  if (error !== undefined && isAbortError(error)) return error;
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

/**
 * `security find-generic-password` 를 한 번 돌린다.
 *
 * 실패는 `undefined` 다 — 단, **취소는 예외다**(위 주석). `signal` 은 `spawn` 에 그대로
 * 넘긴다: Node 는 그 signal 로 자식을 죽이고 `error` 로 AbortError 를 낸다. 그래야
 * 취소된 판정이 자식 프로세스를 남기지 않는다.
 *
 * 정착은 **한 번**이다. abort, spawn 예외, `error`, `close` 는 서로 경쟁할 수 있고
 * (자식을 죽이면 `error` 와 `close` 가 함께 온다) 두 번째 정착은 조용히 무시된다.
 * abort listener 는 정착 시점에 떼어낸다 — 오래 사는 signal 에 listener 를 쌓지 않는다.
 *
 * `spawnImpl` 이 테스트 seam 이다. 실제 Keychain 을 건드리는 테스트는 없다.
 */
export function spawnKeychainLookup({ account, env, spawnImpl = spawn, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    let settled = false;
    let child;
    let onAbort;
    const detach = () => {
      if (onAbort) signal?.removeEventListener?.("abort", onAbort);
      onAbort = undefined;
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      detach();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      detach();
      reject(error);
    };

    if (signal) {
      onAbort = () => {
        // 자식을 먼저 끊는다. `spawn` 에 signal 을 넘겼으면 Node 가 이미 죽였고, 그
        // 경우 이 호출은 무해하다. 주입된 fake child 도 같은 자리에서 정리된다.
        try {
          child?.kill?.();
        } catch {
          // 죽이지 못해도 취소 자체는 그대로 알린다.
        }
        fail(abortReason(signal));
      };
      signal.addEventListener?.("abort", onAbort, { once: true });
    }

    try {
      child = spawnImpl(
        "security",
        ["find-generic-password", "-s", claudeSetupTokenService(account), "-a", env?.USER ?? "", "-w"],
        { stdio: ["ignore", "pipe", "ignore"], ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      // Keychain 이 없는 플랫폼(Linux)에서 spawn 자체가 실패한다. 그것 때문에 provider
      // 구성이 죽으면 안 된다 — 취소가 아닌 실패만 "없음"으로 접는다.
      if (signal?.aborted || isAbortError(error)) fail(abortReason(signal, error));
      else succeed(undefined);
      return;
    }

    // A seam can abort synchronously while `spawnImpl` is running and still return a child.
    // The abort listener then ran before `child` was assigned, so clean up the returned child here.
    if (signal?.aborted) {
      try {
        child?.kill?.();
      } catch {
        // Cancellation still wins even when the child cannot be killed explicitly.
      }
      fail(abortReason(signal));
      return;
    }

    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      if (signal?.aborted || isAbortError(error)) fail(abortReason(signal, error));
      else succeed(undefined);
    });
    child.on("close", (code) => {
      // 취소된 뒤 도착한 `close` 로 token 을 받아들이지 않는다. 죽은 자식의 부분 출력이
      // 유효한 token 으로 보일 수 있고, 그것을 쓰면 취소가 성공으로 바뀐다.
      if (signal?.aborted) fail(abortReason(signal));
      else succeed(code === 0 ? validToken(out) : undefined);
    });
  });
}

/**
 * setup-token 을 찾는다. 파일이 먼저, 없으면 Keychain 이다.
 *
 * 못 찾으면 `undefined`. **던지지 않는다** — setup-token 이 없는 것은 "Claude 로 아직
 * 로그인하지 않았다"이고, 그 상태가 다른 provider 의 부팅을 막아서는 안 된다. 실제
 * 요청 시점에 pinned 층이 "Provider is not configured: anthropic" 으로 답한다.
 *
 * 파일이 있으나 접두가 틀리면 Keychain 으로 넘어간다. bridge 와 같은 동작이다:
 * 잘못된 파일 하나가 멀쩡한 Keychain 항목을 가리지 않는다.
 */
export async function readClaudeSetupToken({
  env = process.env,
  home = homedir(),
  readFileImpl = readFile,
  keychainLookup = spawnKeychainLookup,
  spawnImpl,
  signal,
} = {}) {
  signal?.throwIfAborted?.();
  const account = claudeAccount(env);
  const path = claudeSetupTokenPath(env, home);
  let fromFile;
  try {
    // signal 을 읽기 자체에 넘긴다. 넘기지 않으면 취소된 뒤에도 파일 읽기가 끝까지
    // 돌고, 그 결과를 우리가 받아 든다 — 버려진 자격증명 작업이 살아 있는 것이다.
    fromFile = validToken(await readFileImpl(path, { encoding: "utf-8", ...(signal ? { signal } : {}) }));
  } catch (error) {
    // 취소는 부재가 아니다. ENOENT 만 "없음"으로 접는다.
    if (signal?.aborted || isAbortError(error)) throw abortReason(signal, error);
  }
  // 값을 받아들이기 전에 다시 확인한다. 읽기가 끝나는 것과 취소가 도착하는 것은
  // 경쟁하므로, 이 확인이 없으면 취소된 판정이 token 을 돌려준다.
  signal?.throwIfAborted?.();
  if (fromFile) return { token: fromFile, source: CLAUDE_SETUP_TOKEN_SOURCES.file };
  // 조회 자체가 실패하는 것도 "없음"이다. 여기서 오류를 올리면 Keychain 이 없는
  // 기기에서 Anthropic 자격증명 해석 전체가 오류로 끝난다. 취소는 그 예외다.
  let fromKeychain;
  try {
    fromKeychain = await keychainLookup({ account, env, signal, ...(spawnImpl ? { spawnImpl } : {}) });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw abortReason(signal, error);
    fromKeychain = undefined;
  }
  signal?.throwIfAborted?.();
  return fromKeychain ? { token: fromKeychain, source: CLAUDE_SETUP_TOKEN_SOURCES.keychain } : undefined;
}

/**
 * pinned Anthropic provider 에 setup-token **fallback** 을 덧댄다.
 *
 * 감싸는 것은 `auth.apiKey.resolve` 하나뿐이다. native 가 값을 돌려주면 그것을 그대로
 * 쓴다 — 즉 저장된 자격증명과 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_OAUTH_TOKEN`/
 * `ANTHROPIC_API_KEY` 가 여전히 먼저다. 우선순위를 뒤집으면 사용자가 명시적으로 넣은
 * 값이 파일 하나에 조용히 덮인다.
 *
 * 저장된 OAuth 자격증명은 이 경로를 **지나지도 않는다**: pinned `resolveProviderAuth` 가
 * `auth.oauth` 로 분기한다(`auth/resolve.js:41-43`). 그래서 native OAuth 로 로그인한
 * 프로필은 이 파일이 있어도 영향을 받지 않는다.
 *
 * `login` 도, `check` 도 손대지 않는다. setup-token 은 우리가 발급·갱신하는 값이 아니다.
 */
export function withClaudeSetupToken(provider, options = {}) {
  const nativeApiKey = provider?.auth?.apiKey;
  if (!nativeApiKey || typeof nativeApiKey.resolve !== "function") {
    throw new Error("pinned anthropicProvider has no auth.apiKey.resolve to extend");
  }
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...nativeApiKey,
        resolve: async (args) => {
          const native = await nativeApiKey.resolve(args);
          if (native) return native;
          const found = await readClaudeSetupToken({ ...options, signal: args?.signal });
          if (!found) return undefined;
          // apiKey 로 돌려준다. pinned 층이 `sk-ant-oat` 를 보고 OAuth wire 를 만든다.
          return { auth: { apiKey: found.token }, source: found.source };
        },
      },
    },
  };
}
