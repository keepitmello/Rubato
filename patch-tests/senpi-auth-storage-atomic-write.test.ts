// auth.json 쓰기가 찢어지지 않는지 본다.
//
// 예전 `FileAuthStorageBackend` 는 lock 안에서 `writeFileSync(authPath, next)` 를
// 제자리에 했다. lock 은 **쓰는 사람**을 직렬화하지만 한 번의 쓰기의 **바이트**는
// 지켜 주지 않는다: truncate 뒤 스트리밍 도중에 프로세스가 죽으면 반쯤 쓰인 파일이
// 남고, 다음 읽기는 방금까지 멀쩡했던 자격증명을 parse 실패로 잃는다. OAuth refresh
// 는 이 창을 여러 프로세스가 동시에 지난다.
//
// 소스 텍스트를 보지 않고 **동작**을 본다. 그리고 신호 타이밍으로 사망 지점을 맞추지
// 않는다 — `fs` 를 감싼 shim 으로 **결정적인 결함 지점**(rename 전 / rename 후 /
// 짧은 쓰기)을 주입하고, 실제 자식 크래시는 그 주입 지점에서 자식이 자기를 죽이는
// 방식으로 한 번만 쓴다. 자식은 언제나 finally 에서 정리한다.
//
// 실제 자격증명은 건드리지 않는다. 모든 경로는 임시 디렉터리 안이다.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDOR_PATCHES, collectPatchLayers, locateInStack, stackByFile } from "../postinstall.mjs";

const repoRoot = join(import.meta.dir, "..");
const AUTH_REL = "dist/core/auth-storage.js";
const senpiSpec = VENDOR_PATCHES.find((spec) => spec.seriesName === "@code-yeongyu%2Fsenpi")!;
const senpiRoot = senpiSpec.resolveRoot();
const authModulePath = join(senpiRoot, AUTH_REL);
const coreDir = join(senpiRoot, "dist/core");

let sandbox: string;
let authPath: string;
/** 테스트가 senpi dist 안에 만든 임시 모듈. 반드시 지운다. */
let plantedModules: string[] = [];

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "rubato-auth-atomic-"));
  authPath = join(sandbox, "auth.json");
  plantedModules = [];
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  for (const path of plantedModules) rmSync(path, { force: true });
});

/** auth.json 과 lock 을 뺀 나머지 — temp 잔재가 있으면 여기 잡힌다. */
function strayFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name !== "auth.json" && !name.startsWith("auth.json.lock"));
}

function authStack() {
  return stackByFile(collectPatchLayers(senpiSpec, repoRoot)).get(AUTH_REL)!;
}

function plant(name: string, source: string): string {
  const path = join(coreDir, name);
  writeFileSync(path, source, "utf8");
  plantedModules.push(path);
  return path;
}

/**
 * 결함을 주입한 auth-storage 사본을 만든다.
 *
 * 설치본 바이트에서 `from "fs"` 만 shim 으로 돌린다. 검사 대상 로직(쓰기 루프,
 * rename, 디렉터리 fsync)은 손대지 않는다 — 그래서 이것은 "다른 구현"이 아니라
 * 같은 구현에 결함을 하나 심은 것이다. 같은 디렉터리에 두어 상대 import 가
 * 동일하게 풀린다.
 */
function plantWithFsFault(tag: string, shimBody: string): string {
  const shimName = `auth-storage.__fsfault-${tag}.mjs`;
  plant(
    shimName,
    `import * as real from "fs";
${shimBody}
export * from "fs";
`,
  );
  const installed = readFileSync(authModulePath, "utf8");
  const patched = installed.replace(/ from "fs";/, ` from "./${shimName}";`);
  if (patched === installed) throw new Error("could not redirect the fs import");
  return plant(`auth-storage.__probe-${tag}.js`, patched);
}

/** 자식 프로세스에서 backend 를 돌린다. 자식은 언제나 정리된다. */
function runChild(
  body: string,
  options: { modulePath?: string; allowFailure?: boolean; argv?: string[] } = {},
) {
  const script = `
import { FileAuthStorageBackend } from ${JSON.stringify(`file://${options.modulePath ?? authModulePath}`)};
const authPath = ${JSON.stringify(authPath)};
const backend = new FileAuthStorageBackend(authPath);
${body}
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, "--", ...(options.argv ?? [])],
    {
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
      env: { ...process.env, SENPI_CODING_AGENT_DIR: sandbox, RUBATO_PI_CODING_AGENT_DIR: sandbox },
    },
  );
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`child failed (status=${result.status}, signal=${result.signal}):\n${result.stderr}`);
  }
  return result;
}

/** 파일이 언제나 완전한 JSON 인지 보고, 그 값을 돌려준다. */
function parseTarget(): unknown {
  const raw = readFileSync(authPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`target is not complete JSON (${(error as Error).message}): ${raw.slice(0, 200)}`);
  }
}

const PREVIOUS = { generation: "previous", padding: "p".repeat(8192) };
const NEXT = { generation: "next" };
/** 64바이트 접두사가 진짜 접두사가 되도록 충분히 큰 새 세대. */
const NEXT_LARGE = { generation: "next", padding: "n".repeat(4096) };

function seedPrevious() {
  writeFileSync(authPath, JSON.stringify(PREVIOUS), { encoding: "utf8", mode: 0o600 });
}

describe("FileAuthStorageBackend atomic write", () => {
  test("설치본에 이 series 가 적용돼 있다", () => {
    const installed = readFileSync(authModulePath, "utf8");
    expect(locateInStack(installed, authStack())?.applied).toBe(authStack().length);
  });

  test("sync 경로: 완전한 JSON 을 쓰고 mode 0600 을 지키며 temp 를 남기지 않는다", () => {
    runChild(`
      backend.withLock(() => ({ result: undefined, next: JSON.stringify({ xai: { type: "api_key", key: "k1" } }) }));
    `);
    expect(parseTarget()).toEqual({ xai: { type: "api_key", key: "k1" } });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    expect(strayFiles(sandbox)).toEqual([]);
  });

  test("async 경로: 같은 보장을 받는다", () => {
    runChild(`
      await backend.withLockAsync(async () => ({ result: undefined, next: JSON.stringify({ anthropic: { type: "oauth", refresh: "r" } }) }));
    `);
    expect(parseTarget()).toEqual({ anthropic: { type: "oauth", refresh: "r" } });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    expect(strayFiles(sandbox)).toEqual([]);
  });

  test("파일을 처음 만들 때도 0600 이고 완전한 JSON 이다", () => {
    runChild(`backend.withLock(() => ({ result: undefined }));`);
    expect(parseTarget()).toEqual({});
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    expect(strayFiles(sandbox)).toEqual([]);
  });

  test("짧아지는 내용을 갈아쓴 뒤 이전 꼬리가 남지 않는다", () => {
    seedPrevious();
    runChild(`backend.withLock(() => ({ result: undefined, next: JSON.stringify({ small: true }) }));`);
    const after = readFileSync(authPath, "utf8");
    expect(JSON.parse(after)).toEqual({ small: true });
    expect(after).not.toContain("padding");
    expect(strayFiles(sandbox)).toEqual([]);
  });

  test("짧은 쓰기(short write)를 주입해도 바이트가 잘리지 않는다", () => {
    // 한 번의 writeSync 가 요청보다 적게 쓰는 것은 정상 동작이다. 반환값을 믿지
    // 않으면 자격증명 파일이 조용히 잘린다. 7 바이트씩만 받아 주는 shim 으로
    // 루프가 실제로 도는지 본다. 멀티바이트를 섞어 문자 인덱스로 재개하면 깨지게 둔다.
    const probe = plantWithFsFault(
      "shortwrite",
      `export function writeSync(fd, data, offset, length) {
        const chunk = Math.min(7, length ?? 0);
        return real.writeSync(fd, data, offset, chunk);
      }`,
    );
    const payload = { generation: "next", note: "한글과 emoji 🎹 를 섞는다", padding: "q".repeat(20000) };
    runChild(
      `backend.withLock(() => ({ result: undefined, next: ${JSON.stringify(JSON.stringify(payload))} }));`,
      { modulePath: probe },
    );
    expect(parseTarget()).toEqual(payload);
    expect(strayFiles(sandbox)).toEqual([]);
  });

  test("경계: rename 전에 실패하면 이전 JSON 이 온전하고 temp 도 남지 않는다", () => {
    seedPrevious();
    const probe = plantWithFsFault(
      "prerename",
      `export function renameSync() {
        const error = new Error("injected pre-rename fault");
        error.code = "EIO";
        throw error;
      }`,
    );
    const result = runChild(
      `
      try {
        backend.withLock(() => ({ result: undefined, next: ${JSON.stringify(JSON.stringify(NEXT))} }));
      } catch (error) {
        console.log("PROPAGATED:" + error.message);
      }
    `,
      { modulePath: probe },
    );
    expect(result.stdout).toContain("PROPAGATED:injected pre-rename fault");
    // rename 이 일어나지 않았으므로 이전 세대가 온전해야 한다.
    expect(parseTarget()).toEqual(PREVIOUS);
    // 정리가 돌 수 있는 경로이므로 temp 잔재가 없어야 한다.
    expect(strayFiles(sandbox)).toEqual([]);
  });

  test("경계: rename 뒤 디렉터리 fsync 실패는 새 JSON 을 남기고 durability 실패를 보고한다", () => {
    seedPrevious();
    // 파일 fsync 는 살리고 디렉터리 fsync 만 깨뜨린다. rename 은 이미 끝난 지점이다.
    const probe = plantWithFsFault(
      "postrename",
      `import { statSync } from "fs";
      export function fsyncSync(fd) {
        let isDir = false;
        try { isDir = real.fstatSync(fd).isDirectory(); } catch {}
        if (isDir) {
          const error = new Error("injected dir fsync fault");
          error.code = "EIO";
          throw error;
        }
        return real.fsyncSync(fd);
      }`,
    );
    const result = runChild(
      `
      try {
        backend.withLock(() => ({ result: undefined, next: ${JSON.stringify(JSON.stringify(NEXT))} }));
        console.log("NO_ERROR");
      } catch (error) {
        console.log("PROPAGATED:" + error.message);
        console.log("REPLACED:" + String(error.authFileReplaced));
      }
    `,
      { modulePath: probe },
    );
    // 삼키지 않는다 — durability 를 세우지 못한 쓰기를 성공으로 보고하면 안 된다.
    expect(result.stdout).not.toContain("NO_ERROR");
    expect(result.stdout).toContain("could not fsync its directory");
    // 되돌릴 수 없는 사실을 말한다: 대상은 이미 새 JSON 이다.
    expect(result.stdout).toContain("REPLACED:true");
    expect(parseTarget()).toEqual(NEXT);
    expect(strayFiles(sandbox)).toEqual([]);
  });

  test("fn 이 던지면 파일은 그대로고 오류가 그대로 올라간다", () => {
    seedPrevious();
    const result = runChild(`
      try {
        backend.withLock(() => { throw new Error("refresh exploded"); });
      } catch (error) {
        console.log("PROPAGATED:" + error.message);
      }
    `);
    expect(result.stdout).toContain("PROPAGATED:refresh exploded");
    expect(parseTarget()).toEqual(PREVIOUS);
    expect(strayFiles(sandbox)).toEqual([]);
  });

  test("실제 크래시: rename 직전에 자식이 죽으면 이전 JSON 이 온전하다", () => {
    // 사망 지점을 시간으로 맞추지 않는다. 자식이 rename 직전 그 지점에서 스스로
    // SIGKILL 한다 — 결정적이고, 부모가 기다릴 것도 없다.
    seedPrevious();
    const probe = plantWithFsFault(
      "killbeforerename",
      `export function renameSync() {
        process.kill(process.pid, "SIGKILL");
      }`,
    );
    const result = runChild(
      `backend.withLock(() => ({ result: undefined, next: ${JSON.stringify(JSON.stringify(NEXT))} }));`,
      { modulePath: probe, allowFailure: true },
    );
    expect(result.signal).toBe("SIGKILL");
    // 크래시했으므로 이전 세대가 온전해야 한다. 절대 부분 JSON 이 아니다.
    expect(parseTarget()).toEqual(PREVIOUS);
    // 이 경로는 정리가 돌 수 없다(즉사). temp 는 남을 수 있지만 **대상은 온전**하다.
    // 남더라도 auth.json 자체가 아니라 점 접두사 temp 이므로 읽는 쪽에 영향이 없다.
    for (const name of strayFiles(sandbox)) {
      expect(name.startsWith(".auth.json.")).toBe(true);
      expect(name.endsWith(".tmp")).toBe(true);
    }
  });

  test("실제 크래시: rename 완료 직후에 죽으면 새 JSON 이 온전하다", () => {
    seedPrevious();
    // rename 은 실제로 수행하고, 그 직후에 죽는다.
    const probe = plantWithFsFault(
      "killafterrename",
      `export function renameSync(from, to) {
        real.renameSync(from, to);
        process.kill(process.pid, "SIGKILL");
      }`,
    );
    const result = runChild(
      `backend.withLock(() => ({ result: undefined, next: ${JSON.stringify(JSON.stringify(NEXT))} }));`,
      { modulePath: probe, allowFailure: true },
    );
    expect(result.signal).toBe("SIGKILL");
    // rename 이 끝났으므로 새 세대가 온전해야 한다.
    expect(parseTarget()).toEqual(NEXT);
  });

  test("rename 경계: temp 를 다 쓴 시점에 읽는 독자는 완전한 이전 JSON 을 본다", () => {
    // 원자성의 정의를 직접 본다. 시간에 기대지 않고, rename 이 일어나는 그 지점에
    // 독자를 끼워 넣는다: temp 에는 새 바이트가 다 들어갔고 대상은 아직 이전 세대다.
    seedPrevious();
    // sandbox 밖에 둔다 — sandbox 는 "temp 잔재 없음"을 검사하는 자리다.
    const observedDir = mkdtempSync(join(tmpdir(), "rubato-auth-observed-"));
    const observed = join(observedDir, "observed.json");
    // 이 산출물은 의도적이다. sandbox 는 "temp 잔재 없음"을 검사하는 자리이므로
    // 그 안에 두지 않는다는 것을 주석이 아니라 단정으로 고정한다.
    expect(observed.startsWith(sandbox)).toBe(false);
    const probe = plantWithFsFault(
      "renameboundary",
      `import { copyFileSync } from "fs";
      export function renameSync(from, to) {
        // rename 직전의 대상 상태를 그대로 떠 둔다. 이것이 그 순간의 독자가 보는 것이다.
        copyFileSync(to, ${JSON.stringify(observed)});
        return real.renameSync(from, to);
      }`,
    );
    runChild(
      `backend.withLock(() => ({ result: undefined, next: ${JSON.stringify(JSON.stringify(NEXT))} }));`,
      { modulePath: probe },
    );
    // 그 순간의 독자는 완전한 이전 JSON 을 봤다 — 잘린 바이트가 아니다.
    expect(JSON.parse(readFileSync(observed, "utf8"))).toEqual(PREVIOUS);
    // 그리고 rename 뒤에는 완전한 새 JSON 이다. 중간 상태는 존재하지 않는다.
    expect(parseTarget()).toEqual(NEXT);
    expect(strayFiles(sandbox)).toEqual([]);
    rmSync(observedDir, { recursive: true, force: true });
  });

  test("부분 쓰기 뒤 크래시를 주입해도 대상은 완전한 이전 JSON 이다", () => {
    // 결함의 실제 모양: 바이트를 절반 쓰고 죽는다. patch 된 구현에서는 그 절반이
    // temp 에 들어가고 rename 이 일어나지 않으므로 대상은 손대지 않은 상태다.
    seedPrevious();
    const probe = plantWithFsFault(
      "partialthencrash",
      `export function writeSync(fd, data, offset, length) {
        real.writeSync(fd, data, offset, Math.min(64, length ?? 0));
        const error = new Error("injected crash after partial write");
        error.code = "EIO";
        throw error;
      }`,
    );
    const result = runChild(
      `
      try {
        backend.withLock(() => ({ result: undefined, next: ${JSON.stringify(JSON.stringify(NEXT_LARGE))} }));
      } catch (error) {
        console.log("PROPAGATED:" + error.message);
      }
    `,
      { modulePath: probe },
    );
    expect(result.stdout).toContain("PROPAGATED:injected crash after partial write");
    expect(parseTarget()).toEqual(PREVIOUS);
    expect(strayFiles(sandbox)).toEqual([]);
  });

  test("반례: 같은 부분 쓰기 결함이 patch 이전 바이트에서는 대상을 찢는다", () => {
    // pristine 을 상수로 두지 않는다. 등록된 스택을 역적용해 얻는다.
    // 같은 결함(절반 쓰고 죽음)을 제자리 쓰기 구현에 주입하면, 그 절반이 **대상**에
    // 들어가므로 파일이 깨진다. 확률이 아니라 구조다.
    const installed = readFileSync(authModulePath, "utf8");
    const pristine = locateInStack(installed, authStack())!.pristine;
    expect(pristine).not.toContain("atomicWriteAuthFileSync");

    const shimName = "auth-storage.__pristine-fault.mjs";
    plant(
      shimName,
      `import * as real from "fs";
export function writeFileSync(path, data, options) {
  // 제자리 쓰기의 실제 순서를 그대로 모사한다: truncate 뒤 일부 바이트만 쓰고 죽는다.
  const bytes = Buffer.from(String(data), "utf-8");
  real.writeFileSync(path, bytes.subarray(0, 64), options);
  const error = new Error("injected crash after partial write");
  error.code = "EIO";
  throw error;
}
export * from "fs";
`,
    );
    // 치환이 "무언가 바뀌었다"로는 부족하다. pristine 이 제자리 쓰기에 쓰는 그
    // import 를 정확히 잡았는지 본다 — 못 잡으면 결함이 주입되지 않은 원본이 돌고,
    // 반례는 아무것도 증명하지 않는다.
    expect(pristine).toContain('writeFileSync } from "fs";');
    const redirected = pristine.replace(' } from "fs";', ` } from "./${shimName}";`);
    expect(redirected).not.toBe(pristine);
    expect(redirected).toContain(`writeFileSync } from "./${shimName}";`);
    expect(redirected).not.toContain(' } from "fs";');
    const probe = plant("auth-storage.__pristine-probe.js", redirected);

    seedPrevious();
    const result = runChild(
      `
      try {
        backend.withLock(() => ({ result: undefined, next: ${JSON.stringify(JSON.stringify(NEXT_LARGE))} }));
      } catch (error) {
        console.log("PROPAGATED:" + error.message);
      }
    `,
      { modulePath: probe },
    );
    expect(result.stdout).toContain("PROPAGATED:injected crash after partial write");

    // 이것이 고치는 결함이다: 대상이 부분 JSON 으로 남는다.
    const raw = readFileSync(authPath, "utf8");
    const full = JSON.stringify(NEXT_LARGE);
    // 주입이 실제로 걸렸다는 증거: 대상이 새 내용의 **엄격한 접두사**다.
    expect(raw.length).toBe(64);
    expect(raw.length).toBeLessThan(full.length);
    expect(full.startsWith(raw)).toBe(true);
    // 그리고 그것은 읽을 수 없는 JSON 이다 — 자격증명이 사라진 상태.
    expect(() => JSON.parse(raw)).toThrow();
    // 이전 세대도 남아 있지 않다. 제자리 쓰기는 되돌릴 것이 없다.
    expect(raw).not.toContain("previous");
  });
});
