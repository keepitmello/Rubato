#!/usr/bin/env node
// 엔진 산출물을 레포 밖에 만든다.
//
// 빌드는 큰 번들을 다시 쓰므로 worktree 밖의 프로필 디렉터리에 산출물을 둔다.
// 소스를 편집해도 생성물이 git 상태를 더럽히지 않고, 세션마다 같은 엔진을
// 신선도 검사 후 재사용할 수 있다.
//
// plugin 디렉터리는 통째로 옮긴다. package.json 의
// `imports["#rubato-task-runtime"] → ./extensions/rubato-task.js` 가 자기 위치 기준
// 상대경로이고 빌드는 그 이름을 external 로 남기므로, extensions 만 옮기면
// 이 연결이 끊어진다. extensions + runtime + package.json 이 한 세트다.
//
//   build-engine.mjs           필요할 때만 다시 만든다 (신선하면 즉시 끝)
//   build-engine.mjs --force   무조건 다시 만든다
//   build-engine.mjs --check   신선한지만 보고 끝낸다 (0 신선, 10 낡음)
import { cp, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const srcPluginRoot = join(repoRoot, "packages", "rubato-runtime", "plugin");

/** 레포 밖 엔진 자리. 하네스 프로필 안이라 세션과 수명이 같다. */
const pinnedEngineDir = typeof process.env.RUBATO_ENGINE_DIR === "string" && process.env.RUBATO_ENGINE_DIR.trim() !== ""
  ? process.env.RUBATO_ENGINE_DIR
  : "";
export const engineRoot = pinnedEngineDir ||
  join(process.env.HOME ?? "", ".rubato-pi", "engine", "plugin");

const extensionsDir = join(engineRoot, "extensions");
const mainOutput = join(extensionsDir, "rubato.js");

const mode = process.argv.includes("--check")
  ? "check"
  : process.argv.includes("--force")
  ? "force"
  : "auto";

async function loadBuilder() {
  const [extension, astGrep, lspDaemon] = await Promise.all([
    import(join(srcPluginRoot, "scripts", "build-extension.mjs")),
    import(join(srcPluginRoot, "scripts", "stage-ast-grep-mcp-runtime.mjs")),
    import(join(srcPluginRoot, "scripts", "stage-lsp-daemon-runtime.mjs")),
  ]);
  return { ...extension, ...astGrep, ...lspDaemon };
}

/**
 * 산출물보다 새로 고쳐진 소스가 있는가. 값싼 앞단이다.
 *
 * 정밀한 판단은 checkExtensionCurrent 에 있지만 그것은 확인하려고 임시본을
 * 통째로 다시 빌드한다 — 2초 넘고, 그 임시 자리를 레포 안에 만든다.
 * 세션을 띄울 때마다 치르기에는 비싸다. 대부분은 "고친 게 없다" 이므로
 * mtime 으로 먼저 거르고, 의심스러울 때만 정밀 검사로 내려간다.
 *
 * mtime 은 틀릴 수 있다(브랜치 전환 등). 틀리는 방향이 안전해야 하므로
 * "새 것이 있다" 쪽으로 틀리게 둔다 — 그러면 정밀 검사가 받아준다.
 */
export async function sourcesNewerThanOutput() {
  let outputTime;
  try {
    outputTime = (await stat(mainOutput)).mtimeMs;
  } catch {
    return true;
  }

  // 번들의 입력뿐 아니라 **밖으로 베끼는 것들**도 본다. runtime 과 skills 는
  // 빌드 산출물이 아니라 복사 대상이라, 감시에서 빼면 원본이 바뀌어도
  // 사본이 영영 낡은 채로 남는다.
  const roots = [
    join(repoRoot, "packages", "rubato-runtime", "src"),
    join(repoRoot, "packages", "senpi-task", "src"),
    join(repoRoot, "packages", "ast-grep-mcp", "src"),
    join(repoRoot, "packages", "delegate-core", "src"),
    join(repoRoot, "packages", "lsp-core", "src"),
    join(repoRoot, "packages", "lsp-daemon", "src"),
    join(repoRoot, "packages", "mcp-stdio-core", "src"),
    join(repoRoot, "packages", "memory-core", "src"),
    join(repoRoot, "packages", "model-core", "src"),
    join(repoRoot, "packages", "rubato-config-core", "src"),
    join(repoRoot, "packages", "team-core", "src"),
    join(repoRoot, "packages", "tmux-core", "src"),
    join(repoRoot, "packages", "utils", "src"),
    join(srcPluginRoot, "scripts"),
    join(srcPluginRoot, "runtime"),
    join(srcPluginRoot, "skills"),
    join(srcPluginRoot, "package.json"),
    join(here, "build-engine.mjs"),
  ];

  const skipDirs = new Set(["node_modules", ".git", "dist"]);

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (await walk(join(dir, entry.name))) return true;
        continue;
      }
      try {
        if ((await stat(join(dir, entry.name))).mtimeMs > outputTime) return true;
      } catch {
        // 읽지 못하는 파일은 판단에서 제외한다.
      }
    }
    return false;
  }

  for (const root of roots) {
    // roots 에는 디렉터리도 파일도 들어있다(package.json). 파일이면 walk 가
    // readdir 에서 조용히 false 를 돌려서 그냥 누락된다 — 직접 본다.
    try {
      if ((await stat(root)).isFile()) {
        if ((await stat(root)).mtimeMs > outputTime) return true;
        continue;
      }
    } catch {
      continue;
    }
    if (await walk(root)) return true;
  }
  return false;
}

/**
 * 산출물이 소스와 맞는지. 첫 줄 `// rubato:<소스해시>` 가 소스 전체를 덮으므로
 * 신선도 판단은 이미 엔진 쪽에 있다. 여기서 새로 만들지 않고 그것을 쓴다.
 */
/**
 * 산출물 한 장만 보면 모자란다. 번들은 다섯 장이고, 그 옆에 runtime 과
 * package.json, 그리고 senpi 로더 별칭을 푸는 링크까지 있어야 세션이
 * 온전하다. runtime 을 빼먹었을 때 세션은 그대로 뜨고 ast-grep 과 lsp 만
 * 조용히 꺼졌다 — 빠진 것을 물어보지 않으면 늦게 발견된다.
 */
export function mirrorComplete() {
  const required = [
    join(extensionsDir, "rubato.js"),
    join(extensionsDir, "rubato-task.js"),
    join(extensionsDir, "rubato-member.js"),
    join(extensionsDir, "rubato-memory-mcp.js"),
    join(extensionsDir, "memory-run-supervisor.mjs"),
    join(engineRoot, "package.json"),
    join(engineRoot, "runtime", "dag", "sdk.js"),
    join(engineRoot, "runtime", "ast-grep-mcp", "cli.js"),
    join(engineRoot, "runtime", "lsp-daemon", "dist", "cli.js"),
    join(engineRoot, "node_modules"),
    join(extensionsDir, "node_modules"),
  ];
  if (!required.every((path) => existsSync(path))) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(engineRoot, "package.json"), "utf8"));
    const extensions = manifest.pi?.extensions;
    const taskRuntime = manifest.imports?.["#rubato-task-runtime"];
    return Array.isArray(extensions)
      && extensions.includes("./extensions/rubato.js")
      && taskRuntime === "./extensions/rubato-task.js";
  } catch {
    return false;
  }
}

async function isFresh() {
  if (!existsSync(mainOutput)) return false;
  // 산출물이 아니라 미러링한 것이 빠졌을 수도 있다. 그때는 소스가
  // 그대로여도 다시 만들어야 한다.
  if (!mirrorComplete()) return false;
  if (!await sourcesNewerThanOutput()) return true;

  const { checkExtensionCurrent } = await loadBuilder();
  const result = await checkExtensionCurrent({ outputPath: mainOutput });
  if (result.ok !== true) return false;

  // 소스가 더 새로워 보였지만 실제 내용은 같았다(예: touch, 브랜치 전환,
  // 주석만 고침). 그 사실을 기록해 두지 않으면 다음 실행에도 똑같이 2초짜리
  // 정밀 검사를 다시 한다. 도장을 찍어 다음부터는 단축 경로로 끝낸다.
  await stampOutput();
  return true;
}

/** 산출물이 지금 소스보다 새롭다고 표시한다. */
async function stampOutput() {
  const now = new Date();
  await utimes(mainOutput, now, now).catch(() => {});
}

/**
 * package.json 과 runtime 을 밖으로 옮긴다. 산출물 옆에 있어야 엔진이
 * `#rubato-task-runtime` 과 보조 실행 파일을 자기 자리에서 찾는다.
 */

async function writeRubatoPluginManifest() {
  const manifestPath = join(engineRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const imports = {
    ...(manifest.imports && typeof manifest.imports === "object" ? manifest.imports : {}),
  };
  imports["#rubato-task-runtime"] = "./extensions/rubato-task.js";
  manifest.imports = imports;
  manifest.pi = {
    ...(manifest.pi && typeof manifest.pi === "object" ? manifest.pi : {}),
    extensions: ["./extensions/rubato.js"],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function mirrorPluginShell() {
  await mkdir(engineRoot, { recursive: true });

  // 산출물 옆에 같이 있어야 하는 것들. package.json 의 `files` 가 이 패키지가
  // 실행에 뭐가 필요한지 이미 적어 둔 목록이다.
  //
  // runtime 을 빼먹어서 ast-grep 과 lsp 가 "staged runtime is missing" 으로 조용히
  // 꺼졌던 적이 있다. 세션은 뜨기 때문에 더 늦게 발견된다.
  for (const name of ["runtime"]) {
    const src = join(srcPluginRoot, name);
    const dst = join(engineRoot, name);
    if (!existsSync(src)) continue;
    await rm(dst, { recursive: true, force: true });
    await cp(src, dst, { recursive: true });
  }

  // package.json 은 베끼되, 런처가 보는 extension 경로는 Rubato 번들로 고친다.
  // 레포 안 원본 매니페스트는 개발용 경로를 유지한다.
  await cp(join(srcPluginRoot, "package.json"), join(engineRoot, "package.json"));
  await writeRubatoPluginManifest();

  // 번들은 `@earendil-works/pi-tui` 같은 senpi 로더 별칭을 external 로 남긴다.
  // 세션에서는 senpi 로더가 풀어주지만, lead-overlay 처럼
  // `await import(rubatoExtension)` 으로 직접 불러 로더를 안 거치는 경로도 있다.
  // 그때는 node 가 상위로 올라가며 찾는데, 산출물이 레포 밖에 있으면 위에
  // 아무것도 없어 끊긴다.
  //
  // 그런데 루트 node_modules 하나로는 모자란다. pi-tui 는 호이스팅되지 않고
  // senpi 안에 중첩되어 있어서(engine-paths 의 senpiNested 가 이미 "둘 다 본다"고
  // 적어 둔 그 사정이다), 둘 다 걸어야 한다. 다만 중첩 쪽이 먼저 보여야
  // 하므로 산출물 바로 옆(extensions/node_modules)에 둔다 — node 는 가까운
  // 곳부터 찾기 때문이다.
  const linkPairs = [
    [join(engineRoot, "node_modules"), join(repoRoot, "node_modules")],
    [
      join(engineRoot, "extensions", "node_modules"),
      join(repoRoot, "node_modules", "@code-yeongyu", "senpi", "node_modules"),
    ],
  ];
  for (const [linkPath, target] of linkPairs) {
    await rm(linkPath, { recursive: true, force: true });
    if (existsSync(target)) {
      await symlink(target, linkPath, "dir").catch(() => {});
    }
  }
}

async function build() {
  const { buildExtension, stageAstGrepMcpRuntime, stageLspDaemonRuntime } = await loadBuilder();
  run("bun", ["run", "--cwd", "packages/ast-grep-mcp", "build"]);
  run("bun", ["run", "--cwd", "packages/lsp-daemon", "build"]);
  await mkdir(extensionsDir, { recursive: true });
  // outputPath 하나만 주면 나머지 네 개가 같은 디렉터리에 따라붙는다.
  await buildExtension({ outputPath: mainOutput });
  await mirrorPluginShell();
  await Promise.all([
    stageAstGrepMcpRuntime({
      targetEntry: join(engineRoot, "runtime", "ast-grep-mcp", "cli.js"),
    }),
    stageLspDaemonRuntime({
      targetDist: join(engineRoot, "runtime", "lsp-daemon", "dist"),
      repoRoot,
    }),
  ]);
  await writeFile(join(engineRoot, ".built-from"), `${repoRoot}\n`);

  // 방금 빌드했으니 지금이 가장 새롭다고 도장을 찍는다.
  await stampOutput();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (mode === "check") {
    process.exit(await isFresh() ? 0 : 10);
  }

  if (mode === "auto" && await isFresh()) {
    process.exit(0);
  }

  await build();
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
  }
}
