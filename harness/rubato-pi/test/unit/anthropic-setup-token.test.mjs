// setup-token 해결의 계약. **실제 Keychain 도 `~/.claude` 도 건드리지 않는다** —
// 파일은 임시 디렉터리에, Keychain 은 주입된 lookup 으로 대체한다.
//
// pinned provider 를 그대로 쓴다. shape mock 을 세우면 "우리가 상상한 auth 계약"을
// 검사하는 것이고, 실제로 어긋나는 지점은 상상 밖에 있다.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  CLAUDE_ACCOUNT_ENV,
  CLAUDE_SETUP_TOKEN_FILE_ENV,
  CLAUDE_SETUP_TOKEN_PREFIX,
  CLAUDE_SETUP_TOKEN_SOURCES,
  DEFAULT_CLAUDE_ACCOUNT,
  LEGACY_CLAUDE_ACCOUNT_ENV,
  LEGACY_CLAUDE_SETUP_TOKEN_FILE_ENV,
  claudeAccount,
  claudeSetupTokenPath,
  claudeSetupTokenService,
  readClaudeSetupToken,
  spawnKeychainLookup,
  withClaudeSetupToken,
} from "../../src/anthropic-setup-token.mjs";
import { senpiNested } from "../../src/engine-paths.mjs";

/** 실제 token 과 겹칠 수 없는 값. 접두만 진짜와 같게 둔다. */
const TOKEN = `${CLAUDE_SETUP_TOKEN_PREFIX}-test-only-not-a-real-token`;
const KEYCHAIN_TOKEN = `${CLAUDE_SETUP_TOKEN_PREFIX}-test-only-from-keychain`;

function box(t) {
  const dir = mkdtempSync(join(tmpdir(), "rubato-claude-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Keychain 을 절대 부르지 않는 lookup. 부르면 그 자리에서 실패한다. */
function forbiddenKeychain() {
  return async () => {
    throw new Error("Keychain 을 부르면 안 되는 경로에서 불렀다");
  };
}

async function pinnedAnthropicProvider() {
  const module = await import(
    pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/providers/anthropic.js")).href
  );
  return module.anthropicProvider();
}

/** pinned resolve 가 받는 인자 모양. `ctx.env` 와 `signal` 이 계약이다. */
function resolveArgs({ env = {}, credential } = {}) {
  return {
    ctx: {
      env: async (name) => env[name],
      fileExists: async () => false,
    },
    ...(credential ? { credential } : {}),
    signal: AbortSignal.timeout(30_000),
  };
}

// ------------------------------------------------------------------ env 이름

test("계정 기본값은 sub 이고, canonical env 가 legacy FX 이름을 이긴다", () => {
  assert.equal(DEFAULT_CLAUDE_ACCOUNT, "sub");
  assert.equal(claudeAccount({}), "sub");
  assert.equal(claudeAccount({ [CLAUDE_ACCOUNT_ENV]: "main" }), "main");
  assert.equal(claudeAccount({ [LEGACY_CLAUDE_ACCOUNT_ENV]: "legacy" }), "legacy", "legacy 도 읽는다");
  assert.equal(
    claudeAccount({ [CLAUDE_ACCOUNT_ENV]: "main", [LEGACY_CLAUDE_ACCOUNT_ENV]: "legacy" }),
    "main",
    "두 이름이 공존하면 Rubato 이름이 이긴다",
  );
  // 빈 문자열은 계정 이름이 아니다. 그것을 값으로 받으면 service 이름이
  // "Claude Code-setup-token-" 이 되어 아무것도 찾지 못한다.
  assert.equal(claudeAccount({ [CLAUDE_ACCOUNT_ENV]: "" }), "sub");
});

test("token 파일 경로도 canonical env 가 먼저다", () => {
  const home = "/tmp/fake-home-not-used";
  assert.equal(claudeSetupTokenPath({}, home), join(home, ".claude", "auth", "setup-token-sub"));
  assert.equal(
    claudeSetupTokenPath({ [CLAUDE_ACCOUNT_ENV]: "work" }, home),
    join(home, ".claude", "auth", "setup-token-work"),
  );
  assert.equal(claudeSetupTokenPath({ [CLAUDE_SETUP_TOKEN_FILE_ENV]: "/x/token" }, home), "/x/token");
  assert.equal(claudeSetupTokenPath({ [LEGACY_CLAUDE_SETUP_TOKEN_FILE_ENV]: "/y/token" }, home), "/y/token");
  assert.equal(
    claudeSetupTokenPath(
      { [CLAUDE_SETUP_TOKEN_FILE_ENV]: "/x/token", [LEGACY_CLAUDE_SETUP_TOKEN_FILE_ENV]: "/y/token" },
      home,
    ),
    "/x/token",
  );
});

test("Keychain service 이름은 bridge 가 쓰던 것과 같다", () => {
  assert.equal(claudeSetupTokenService("sub"), "Claude Code-setup-token-sub");
});

// ------------------------------------------------------------- 출처와 우선순위

test("token 파일이 있으면 그것을 쓰고 Keychain 은 부르지 않는다", async (t) => {
  const dir = box(t);
  const path = join(dir, "setup-token-sub");
  writeFileSync(path, `${TOKEN}\n`, { mode: 0o600 });
  const found = await readClaudeSetupToken({
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: path },
    keychainLookup: forbiddenKeychain(),
  });
  assert.equal(found.token, TOKEN, "개행이 붙은 파일도 그대로 읽어야 한다");
  assert.equal(found.source, CLAUDE_SETUP_TOKEN_SOURCES.file);
});

test("파일이 없으면 Keychain 으로 넘어간다", async (t) => {
  const dir = box(t);
  const calls = [];
  const found = await readClaudeSetupToken({
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: join(dir, "absent"), [CLAUDE_ACCOUNT_ENV]: "work" },
    keychainLookup: async (args) => {
      calls.push(args.account);
      return KEYCHAIN_TOKEN;
    },
  });
  assert.deepEqual(calls, ["work"], "Keychain 조회는 계정 이름으로 한 번이다");
  assert.equal(found.token, KEYCHAIN_TOKEN);
  assert.equal(found.source, CLAUDE_SETUP_TOKEN_SOURCES.keychain);
});

test("접두가 틀린 파일은 Keychain 을 가리지 않는다", async (t) => {
  const dir = box(t);
  const path = join(dir, "setup-token-sub");
  // API key 를 그 파일에 넣어 둔 경우다. 이것을 apiKey 로 넘기면 pinned 판정이 OAuth 가
  // 아니라 x-api-key 경로를 골라, Claude Code 신원 없이 조용히 다른 요청이 나간다.
  writeFileSync(path, "sk-ant-api03-not-a-setup-token\n", { mode: 0o600 });
  const found = await readClaudeSetupToken({
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: path },
    keychainLookup: async () => KEYCHAIN_TOKEN,
  });
  assert.equal(found.token, KEYCHAIN_TOKEN, "잘못된 파일 하나가 멀쩡한 Keychain 항목을 가리면 안 된다");
});

test("접두만 있고 값이 없는 것은 token 이 아니다", async (t) => {
  const dir = box(t);
  const path = join(dir, "setup-token-sub");
  writeFileSync(path, `${CLAUDE_SETUP_TOKEN_PREFIX}\n`, { mode: 0o600 });
  const found = await readClaudeSetupToken({
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: path },
    keychainLookup: async () => undefined,
  });
  assert.equal(found, undefined);
});

test("양쪽 다 없으면 undefined 다 — 던지지 않는다", async (t) => {
  const dir = box(t);
  // 여기서 던지면 Claude 로 로그인하지 않은 사용자의 세션 부팅이 막힌다.
  const found = await readClaudeSetupToken({
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: join(dir, "absent") },
    keychainLookup: async () => undefined,
  });
  assert.equal(found, undefined);
});

/**
 * `security` 를 흉내내는 자식 프로세스. **실제 Keychain 은 부르지 않는다.**
 *
 * 기본 lookup 의 계약을 그 자리에서 본다: 인자 모양, exit code 판정, 접두 검사,
 * spawn 실패의 접기. 이것을 주입 lookup 으로 대체하면 정작 운영에서 쓰이는 경로가
 * 한 번도 실행되지 않는다.
 */
function fakeSecurity({ stdout = "", code = 0, spawnThrows = false, emitError = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (spawnThrows) throw new Error("spawn security ENOENT");
    const handlers = new Map();
    const child = {
      stdout: {
        on: (event, handler) => {
          if (event === "data" && stdout) handler(Buffer.from(stdout, "utf-8"));
        },
      },
      on: (event, handler) => {
        handlers.set(event, handler);
        // 등록이 끝난 뒤에 종단을 알린다. 동기적으로 부르면 `close` 핸들러가
        // 아직 등록되지 않은 순서에 걸린다.
        queueMicrotask(() => {
          if (emitError && event === "error") handler(new Error("security failed"));
          else if (!emitError && event === "close") handler(code);
        });
        return child;
      },
    };
    return child;
  };
  return { spawnImpl, calls };
}

test("기본 Keychain lookup 의 인자와 판정 (fake spawn)", async (t) => {
  const dir = box(t);
  const absent = join(dir, "absent");

  // 1) 성공 경로. 인자 모양이 계약이다 — service 이름과 `-w`(값만 출력).
  const ok = fakeSecurity({ stdout: `${KEYCHAIN_TOKEN}\n` });
  const found = await readClaudeSetupToken({
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: absent, [CLAUDE_ACCOUNT_ENV]: "work", USER: "tester" },
    spawnImpl: ok.spawnImpl,
  });
  assert.equal(found.token, KEYCHAIN_TOKEN);
  assert.equal(found.source, CLAUDE_SETUP_TOKEN_SOURCES.keychain);
  assert.equal(ok.calls.length, 1, "조회는 한 번이다");
  assert.equal(ok.calls[0].command, "security");
  assert.deepEqual(ok.calls[0].args, [
    "find-generic-password",
    "-s",
    "Claude Code-setup-token-work",
    "-a",
    "tester",
    "-w",
  ]);
  // 자격증명이 stderr 로 새지 않게 stdio 를 고정한다.
  assert.deepEqual(ok.calls[0].options.stdio, ["ignore", "pipe", "ignore"]);

  // 2) 항목이 없으면 exit code 가 0 이 아니다 → undefined.
  const missing = fakeSecurity({ stdout: "", code: 44 });
  assert.equal(
    await readClaudeSetupToken({
      env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: absent },
      spawnImpl: missing.spawnImpl,
    }),
    undefined,
  );

  // 3) exit 0 인데 접두가 틀린 값도 token 이 아니다.
  const wrongPrefix = fakeSecurity({ stdout: "sk-ant-api03-wrong\n" });
  assert.equal(
    await readClaudeSetupToken({
      env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: absent },
      spawnImpl: wrongPrefix.spawnImpl,
    }),
    undefined,
  );

  // 4) spawn 이 던지는 기기(Keychain 이 없는 플랫폼)에서도 조용히 undefined 다.
  const broken = fakeSecurity({ spawnThrows: true });
  assert.equal(
    await readClaudeSetupToken({
      env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: absent },
      spawnImpl: broken.spawnImpl,
    }),
    undefined,
  );

  // 5) 자식이 `error` 를 내는 경로도 같다.
  const errored = fakeSecurity({ emitError: true });
  assert.equal(
    await readClaudeSetupToken({
      env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: absent },
      spawnImpl: errored.spawnImpl,
    }),
    undefined,
  );
});

test("lookup 이 던져도 자격증명 해석은 오류로 끝나지 않는다", async (t) => {
  const dir = box(t);
  const found = await readClaudeSetupToken({
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: join(dir, "absent") },
    keychainLookup: async () => {
      throw new Error("Keychain locked");
    },
  });
  assert.equal(found, undefined);
});

// ------------------------------------------------------------------ 취소 계약
//
// 취소는 **부재가 아니다.** `undefined` 는 "이 기기에 setup-token 이 없다"는 사실이고,
// 취소는 "판정을 끝내지 못했다"다. 취소를 부재로 접으면 pinned resolver 가 취소를
// 정착시키지 못해 취소된 요청이 auth 오류로 끝나고, 버려진 자격증명 작업(파일 읽기,
// Keychain 조회, 자식 프로세스)이 그대로 살아남는다.
//
// 아래 테스트는 시간에 기대지 않는다. 취소는 주입된 seam 안에서 **동기적으로** 일어나고,
// 그 signal 이 곧 판정 신호다. 고정 sleep 도, polling 도 없다.

/** 표준 AbortError. 실제 `fs`/`child_process` 가 내는 모양과 같게 둔다. */
function abortError() {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

test("파일 읽기에 signal 을 넘긴다 — 취소는 부재가 아니라 거절이다", async (t) => {
  const dir = box(t);
  const controller = new AbortController();
  const seen = {};
  // 실제 `fs/promises.readFile` 과 같은 계약을 흉내낸다: signal 을 받고, 그것이
  // 끊기면 AbortError 로 거절한다. 취소는 이 호출 안에서 동기적으로 일어난다.
  const readFileImpl = (path, options) => {
    seen.path = path;
    seen.options = options;
    return new Promise((_, rejectRead) => {
      options.signal.addEventListener("abort", () => rejectRead(abortError()), { once: true });
      controller.abort();
    });
  };

  await assert.rejects(
    () => readClaudeSetupToken({
      env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: join(dir, "setup-token-sub") },
      readFileImpl,
      keychainLookup: forbiddenKeychain(),
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error.name, "AbortError", `취소가 AbortError 로 정착하지 않았다: ${error.name}`);
      return true;
    },
    "취소를 undefined 로 접으면 pinned resolver 가 취소를 정착시키지 못한다",
  );

  // signal 이 실제로 읽기까지 내려갔는지 본다. 내려가지 않으면 취소된 뒤에도 파일
  // 읽기가 끝까지 돌고, 그것이 "버려진 자격증명 작업"이다.
  assert.equal(seen.options.signal, controller.signal, "signal 이 readFile 옵션에 실리지 않았다");
  assert.equal(seen.options.encoding, "utf-8", "인코딩 계약이 사라지면 Buffer 를 token 으로 읽는다");
});

test("취소 뒤에 도착한 파일 내용은 token 으로 받아들이지 않는다", async (t) => {
  const dir = box(t);
  const controller = new AbortController();
  // 읽기가 취소와 경쟁해서 **이긴** 경우다. signal 을 무시하는 파일 시스템에서 실제로
  // 일어난다. 이때 token 을 돌려주면 취소가 성공으로 바뀐다.
  const readFileImpl = async () => {
    controller.abort();
    return `${TOKEN}\n`;
  };
  await assert.rejects(
    () => readClaudeSetupToken({
      env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: join(dir, "setup-token-sub") },
      readFileImpl,
      keychainLookup: forbiddenKeychain(),
      signal: controller.signal,
    }),
    (error) => error.name === "AbortError",
    "취소된 판정이 token 을 돌려줬다",
  );
});

test("이미 끊긴 signal 로는 파일도 Keychain 도 건드리지 않는다", async (t) => {
  const dir = box(t);
  const controller = new AbortController();
  controller.abort();
  let touched = 0;
  await assert.rejects(
    () => readClaudeSetupToken({
      env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: join(dir, "setup-token-sub") },
      readFileImpl: async () => {
        touched += 1;
        return `${TOKEN}\n`;
      },
      keychainLookup: forbiddenKeychain(),
      signal: controller.signal,
    }),
    (error) => error.name === "AbortError",
  );
  assert.equal(touched, 0, "끊긴 signal 로 자격증명 작업을 시작했다");
});

test("ENOENT 는 여전히 부재다 — 취소만 거절한다", async (t) => {
  const dir = box(t);
  // 대조군. 이것이 undefined 로 남지 않으면 Claude 로 로그인하지 않은 사용자의
  // 세션 부팅이 막힌다.
  const controller = new AbortController();
  const found = await readClaudeSetupToken({
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: join(dir, "absent") },
    keychainLookup: async () => undefined,
    signal: controller.signal,
  });
  assert.equal(found, undefined);
});

test("Keychain 조회의 취소도 거절로 정착한다", async (t) => {
  const dir = box(t);
  const controller = new AbortController();
  await assert.rejects(
    () => readClaudeSetupToken({
      env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: join(dir, "absent") },
      keychainLookup: async ({ signal }) => {
        assert.equal(signal, controller.signal, "signal 이 Keychain 조회로 내려가지 않았다");
        controller.abort();
        throw abortError();
      },
      signal: controller.signal,
    }),
    (error) => error.name === "AbortError",
    "Keychain 취소를 부재로 접었다",
  );
});

test("취소가 아닌 Keychain 실패는 계속 부재다", async (t) => {
  const dir = box(t);
  const controller = new AbortController();
  const found = await readClaudeSetupToken({
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: join(dir, "absent") },
    keychainLookup: async () => {
      throw new Error("Keychain locked");
    },
    signal: controller.signal,
  });
  assert.equal(found, undefined, "취소가 아닌 실패가 다른 provider 를 막았다");
});

// ------------------------------------------- 기본 lookup 의 취소 (fake spawn)

/**
 * 취소를 관측할 수 있는 fake `security` 자식.
 *
 * `kill()` 호출 여부와 listener 등록/해제를 기록한다. 실제 Keychain 도 실제 프로세스도
 * 만들지 않는다. 종단 event 는 테스트가 직접 쏴서 순서를 결정한다 — 경쟁을 시간이
 * 아니라 호출 순서로 만든다.
 */
function controllableChild() {
  const handlers = new Map();
  const state = { killed: 0, listeners: 0 };
  const child = {
    stdout: {
      on: (event, handler) => {
        if (event === "data") handlers.set("data", handler);
        return child.stdout;
      },
    },
    on: (event, handler) => {
      handlers.set(event, handler);
      state.listeners += 1;
      return child;
    },
    kill: () => {
      state.killed += 1;
      return true;
    },
  };
  return {
    child,
    state,
    emitData: (text) => handlers.get("data")?.(Buffer.from(text, "utf-8")),
    emitClose: (code) => handlers.get("close")?.(code),
    emitError: (error) => handlers.get("error")?.(error),
  };
}

test("기본 lookup: signal 을 spawn 에 넘기고 취소 때 자식을 끊는다", async () => {
  const controller = new AbortController();
  const fake = controllableChild();
  const calls = [];
  const promise = spawnKeychainLookup({
    account: "sub",
    env: { USER: "tester" },
    signal: controller.signal,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return fake.child;
    },
  });

  // signal 이 spawn 옵션에 실렸는가. 실리지 않으면 Node 가 자식을 죽이지 않는다.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal, controller.signal, "signal 이 spawn 으로 내려가지 않았다");
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "ignore"]);

  controller.abort();
  await assert.rejects(() => promise, (error) => error.name === "AbortError");
  assert.equal(fake.state.killed, 1, "취소했는데 자식 프로세스를 끊지 않았다");
});

test("기본 lookup: spawn 중 동기 취소 뒤 반환된 자식도 끊는다", async () => {
  const controller = new AbortController();
  const fake = controllableChild();
  const promise = spawnKeychainLookup({
    account: "sub",
    env: { USER: "tester" },
    signal: controller.signal,
    spawnImpl: () => {
      controller.abort();
      return fake.child;
    },
  });

  await assert.rejects(() => promise, (error) => error.name === "AbortError");
  assert.equal(fake.state.killed, 1, "spawn 중 취소 뒤 반환된 자식을 남겼다");
});

test("기본 lookup: 취소 뒤 도착한 close 는 token 을 만들지 않는다", async () => {
  const controller = new AbortController();
  const fake = controllableChild();
  const promise = spawnKeychainLookup({
    account: "sub",
    env: { USER: "tester" },
    signal: controller.signal,
    spawnImpl: () => fake.child,
  });
  // 죽은 자식이 유효한 token 을 내놓은 것처럼 만든다. 이것을 받아들이면 취소가
  // 성공으로 바뀐다.
  fake.emitData(`${KEYCHAIN_TOKEN}\n`);
  controller.abort();
  fake.emitClose(0);
  await assert.rejects(() => promise, (error) => error.name === "AbortError", "늦게 온 token 을 받아들였다");
});

test("기본 lookup: 정착은 한 번이고 listener 를 남기지 않는다", async () => {
  const controller = new AbortController();
  const fake = controllableChild();
  const promise = spawnKeychainLookup({
    account: "sub",
    env: { USER: "tester" },
    signal: controller.signal,
    spawnImpl: () => fake.child,
  });
  // abort, error, close 가 한꺼번에 온다 — 자식을 죽이면 실제로 그렇게 된다.
  controller.abort();
  fake.emitError(abortError());
  fake.emitClose(null);
  fake.emitClose(0);
  await assert.rejects(() => promise, (error) => error.name === "AbortError");
  // 두 번째 정착이 예외를 내지 않고 조용히 무시됐다는 것이 위 await 가 통과한 근거다.
  // 그리고 abort listener 는 떼어냈다 — 오래 사는 signal 에 쌓이면 누수다.
  assert.equal(controller.signal.aborted, true);
});

test("기본 lookup: 취소 없이 끝난 자식은 평소처럼 판정한다", async () => {
  const controller = new AbortController();
  for (const [label, code, data, expected] of [
    ["성공", 0, `${KEYCHAIN_TOKEN}\n`, KEYCHAIN_TOKEN],
    ["항목 없음", 44, "", undefined],
    ["접두 불일치", 0, "sk-ant-api03-wrong\n", undefined],
  ]) {
    const fake = controllableChild();
    const promise = spawnKeychainLookup({
      account: "sub",
      env: { USER: "tester" },
      signal: controller.signal,
      spawnImpl: () => fake.child,
    });
    if (data) fake.emitData(data);
    fake.emitClose(code);
    assert.equal(await promise, expected, `${label} 판정이 바뀌었다`);
  }
  assert.equal(controller.signal.aborted, false, "이 경로에서 취소가 일어나면 안 된다");
});

test("기본 lookup: 취소가 아닌 spawn 실패는 부재다", async () => {
  const controller = new AbortController();
  assert.equal(
    await spawnKeychainLookup({
      account: "sub",
      env: {},
      signal: controller.signal,
      spawnImpl: () => {
        throw new Error("spawn security ENOENT");
      },
    }),
    undefined,
  );
  // 그런데 같은 자리에서 취소였다면 거절이다.
  const aborted = new AbortController();
  await assert.rejects(
    () => spawnKeychainLookup({
      account: "sub",
      env: {},
      signal: aborted.signal,
      spawnImpl: () => {
        aborted.abort();
        throw abortError();
      },
    }),
    (error) => error.name === "AbortError",
  );
});

test("기본 lookup: 이미 끊긴 signal 로는 spawn 하지 않는다", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = 0;
  await assert.rejects(
    () => spawnKeychainLookup({
      account: "sub",
      env: {},
      signal: controller.signal,
      spawnImpl: () => {
        spawned += 1;
        return controllableChild().child;
      },
    }),
    (error) => error.name === "AbortError",
  );
  assert.equal(spawned, 0, "끊긴 signal 로 프로세스를 띄웠다");
});

// --------------------------------------------------------- provider 통합 계약

test("native 가 값을 찾으면 setup-token 은 읽히지도 않는다", async (t) => {
  const dir = box(t);
  const path = join(dir, "setup-token-sub");
  writeFileSync(path, `${TOKEN}\n`, { mode: 0o600 });
  let reads = 0;
  const provider = withClaudeSetupToken(await pinnedAnthropicProvider(), {
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: path },
    readFileImpl: async (...args) => {
      reads += 1;
      const { readFile } = await import("node:fs/promises");
      return readFile(...args);
    },
    keychainLookup: forbiddenKeychain(),
  });

  // 1) 저장된 api_key 자격증명이 이긴다.
  const stored = await provider.auth.apiKey.resolve(
    resolveArgs({ credential: { type: "api_key", key: "stored-key-not-a-real-token" } }),
  );
  assert.equal(stored.auth.apiKey, "stored-key-not-a-real-token");
  assert.equal(stored.source, "stored credential");

  // 2) env 도 이긴다. pinned 순서 그대로다: AUTH_TOKEN → OAUTH_TOKEN → API_KEY.
  const authToken = await provider.auth.apiKey.resolve(
    resolveArgs({ env: { ANTHROPIC_AUTH_TOKEN: "env-bearer-not-a-real-token" } }),
  );
  assert.equal(authToken.auth.headers.Authorization, "Bearer env-bearer-not-a-real-token");
  assert.equal(authToken.source, "ANTHROPIC_AUTH_TOKEN");

  const oauthEnv = await provider.auth.apiKey.resolve(
    resolveArgs({ env: { ANTHROPIC_OAUTH_TOKEN: "env-oauth-not-a-real-token" } }),
  );
  assert.equal(oauthEnv.auth.apiKey, "env-oauth-not-a-real-token");
  assert.equal(oauthEnv.source, "ANTHROPIC_OAUTH_TOKEN");

  const apiKeyEnv = await provider.auth.apiKey.resolve(
    resolveArgs({ env: { ANTHROPIC_API_KEY: "env-apikey-not-a-real-token" } }),
  );
  assert.equal(apiKeyEnv.auth.apiKey, "env-apikey-not-a-real-token");
  assert.equal(apiKeyEnv.source, "ANTHROPIC_API_KEY");

  assert.equal(reads, 0, "native 가 답한 경로에서 setup-token 파일을 읽었다");
});

test("native 가 비면 setup-token 을 apiKey 로 돌려준다", async (t) => {
  const dir = box(t);
  const path = join(dir, "setup-token-sub");
  writeFileSync(path, `${TOKEN}\n`, { mode: 0o600 });
  const provider = withClaudeSetupToken(await pinnedAnthropicProvider(), {
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: path },
    keychainLookup: forbiddenKeychain(),
  });
  const resolved = await provider.auth.apiKey.resolve(resolveArgs());
  // apiKey 여야 한다. headers 로 실으면 pinned 의 `sk-ant-oat` 판정이 그것을 보지
  // 못하고 Claude Code 신원이 붙지 않는다.
  assert.equal(resolved.auth.apiKey, TOKEN);
  assert.equal(resolved.auth.headers, undefined, "headers 로 실으면 OAuth 판정을 지나치지 못한다");
  assert.equal(resolved.source, CLAUDE_SETUP_TOKEN_SOURCES.file);
});

test("setup-token 이 없으면 undefined 를 돌려준다 (부팅을 막지 않는다)", async (t) => {
  const dir = box(t);
  const provider = withClaudeSetupToken(await pinnedAnthropicProvider(), {
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: join(dir, "absent") },
    keychainLookup: async () => undefined,
  });
  assert.equal(await provider.auth.apiKey.resolve(resolveArgs()), undefined);
});

test("pinned 의 다른 auth 면은 그대로 남는다", async () => {
  const native = await pinnedAnthropicProvider();
  const provider = withClaudeSetupToken(native, { env: {} });
  assert.equal(provider.id, "anthropic");
  assert.equal(provider.baseUrl, native.baseUrl);
  assert.equal(provider.auth.oauth, native.auth.oauth, "OAuth 정의를 바꾸면 로그인 흐름이 갈라진다");
  assert.equal(provider.auth.apiKey.name, native.auth.apiKey.name);
  assert.equal(provider.auth.apiKey.login, native.auth.apiKey.login, "login 은 우리 것이 아니다");
  // 모델 metadata 는 하나도 손대지 않는다.
  assert.deepEqual(
    provider.getModels().map((model) => model.id),
    native.getModels().map((model) => model.id),
  );
});

test("resolve 를 확장할 수 없는 provider 는 조용히 통과하지 않는다", () => {
  assert.throws(() => withClaudeSetupToken({ id: "anthropic", auth: {} }), /auth\.apiKey\.resolve/);
  assert.throws(() => withClaudeSetupToken({ id: "anthropic", auth: { apiKey: {} } }), /auth\.apiKey\.resolve/);
});

test("token 파일을 읽기만 한다 — mtime 과 크기가 그대로다", async (t) => {
  const dir = box(t);
  const path = join(dir, "setup-token-sub");
  writeFileSync(path, `${TOKEN}\n`, { mode: 0o600 });
  const before = statSync(path);
  const provider = withClaudeSetupToken(await pinnedAnthropicProvider(), {
    env: { [CLAUDE_SETUP_TOKEN_FILE_ENV]: path },
    keychainLookup: forbiddenKeychain(),
  });
  await provider.auth.apiKey.resolve(resolveArgs());
  const after = statSync(path);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs, "token 파일을 건드렸다");
  assert.equal(before.mode, after.mode);
});
