#!/usr/bin/env node
// 벤더 패치를 뜨는 자리.
//
// 규칙은 둘이다: **node_modules 를 직접 고치지 않는다**, **병렬 작업에 안전하다.**
// 그래서 편집은 세션 전용 임시 디렉터리에서 하고, 결과는 기존 patch 를 건드리지
// 않는 새 파일 하나로 떨어진다.
//
//   vendor-patch open senpi                 작업 공간을 만든다 → 경로를 알려준다
//   ...거기서 편집한다...
//   vendor-patch save senpi transcript-cache 새 patch 를 하나 만든다
//
// pristine tarball(`npm pack`)을 받지 않는다. 새 patch 가 얹힐 자리는 pristine 이
// 아니라 **baseline + 현재 series 를 적용한 상태**이고, 그건 설치본이 이미 그
// 상태이기 때문이다 — postinstall 이 매번 역적용 round-trip 으로 그것을 검증한다.
// 그래서 여기서는 설치본을 두 벌 복사한다: 편집할 `work/` 와 비교 기준 `base/`.
// 네트워크도, tarball 해제도, 역적용도 필요 없다. `open` 이 복사 전에 설치본이
// 정말 series 와 일치하는지 확인하므로 기준의 권위는 그대로다.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { formatPatch, structuredPatch } from "diff";
import { VENDOR_PATCHES, collectPatchLayers, locateInStack, parseFilePatches, seriesDir, stackByFile } from "../../postinstall.mjs";

const ALIASES = { senpi: 0, "senpi-tui": 1, "pi-ai": 2, "senpi-codemode": 3 };

function fail(message) {
  process.stderr.write(`vendor-patch: ${message}\n`);
  process.exit(1);
}

function specOf(alias) {
  const index = ALIASES[alias];
  if (index === undefined) fail(`unknown package "${alias}". known: ${Object.keys(ALIASES).join(", ")}`);
  return VENDOR_PATCHES[index];
}

function sessionName(args) {
  const flag = args.indexOf("--session");
  if (flag >= 0 && args[flag + 1]) return args[flag + 1];
  return process.env.RUBATO_VENDOR_SESSION ?? "default";
}

function workspace(alias, session) {
  const root = join(process.env.RUBATO_VENDOR_ROOT ?? tmpdir(), `rubato-vendor-${session}`, alias);
  return { root, base: join(root, "base"), work: join(root, "work") };
}

/** node_modules 는 패키지의 내용이 아니라 그 아래 깔린 다른 패키지들이다. */
function listFiles(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function copyPackage(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (source) => relative(from, source).split(sep)[0] !== "node_modules",
  });
}

/**
 * 설치본이 정말 baseline + series 를 적용한 상태인지 본다. 여기서 어긋난 것을
 * 기준으로 삼으면 새 patch 에 남의 변경이 섞여 들어간다.
 */
function assertInstalledMatchesSeries(spec, packageRoot) {
  const stacks = stackByFile(collectPatchLayers(spec));
  for (const [relativePath, stack] of stacks) {
    const targetPath = join(packageRoot, relativePath);
    const source = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
    const located = locateInStack(source, stack);
    if (located === null || located.applied !== stack.length) {
      fail(
        `${relativePath} in the installed package does not match the patch series. ` +
        "Run `node postinstall.mjs` first, and do not edit node_modules by hand.",
      );
    }
  }
}

function open(alias, args) {
  const spec = specOf(alias);
  const packageRoot = spec.resolveRoot();
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.version !== spec.expectedVersion) {
    fail(`installed ${spec.packageName} is ${manifest.version}, patches target ${spec.expectedVersion}`);
  }
  assertInstalledMatchesSeries(spec, packageRoot);

  const session = sessionName(args);
  const paths = workspace(alias, session);
  if (existsSync(paths.work) && !args.includes("--force")) {
    fail(`${paths.work} already exists. Save it, or pass --force to throw it away.`);
  }
  copyPackage(packageRoot, paths.base);
  copyPackage(packageRoot, paths.work);

  process.stdout.write(
    `작업 공간 (session: ${session})\n` +
    `  편집:   ${paths.work}\n` +
    `  기준:   ${paths.base}  (건드리지 마라)\n\n` +
    `끝나면:  node harness/scripts/vendor-patch.mjs save ${alias} <change-id>` +
    (session === "default" ? "\n" : ` --session ${session}\n`),
  );
}

/** 한 파일의 변경을 우리 patch 형식(diff --git 헤더 + unified hunks)으로 만든다. */
function fileDiff(relativePath, before, after) {
  const patch = structuredPatch(`a/${relativePath}`, `b/${relativePath}`, before, after, undefined, undefined, { context: 3 });
  if (patch.hunks.length === 0) return "";
  // formatPatch 는 "===..." 구분선으로 시작한다. 우리 파서는 `diff --git` 으로
  // chunk 를 가르므로 그 줄을 우리 헤더로 갈아 끼운다.
  const body = formatPatch(patch).replace(/^=+\n/, "");
  const header = before === ""
    ? `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n`
    : `diff --git a/${relativePath} b/${relativePath}\n`;
  const withDevNull = before === "" ? body.replace(`--- a/${relativePath}`, "--- /dev/null") : body;
  return header + withDevNull;
}

function save(alias, changeId, args) {
  const spec = specOf(alias);
  if (!changeId || !/^[a-z0-9][a-z0-9-]*$/.test(changeId)) {
    fail("change id must be lower-case letters, digits and dashes — it becomes the patch file name");
  }
  const session = sessionName(args);
  const paths = workspace(alias, session);
  if (!existsSync(paths.work) || !existsSync(paths.base)) fail(`no workspace at ${paths.root}. Run \`open\` first.`);

  const baseFiles = new Set(listFiles(paths.base));
  const workFiles = listFiles(paths.work);
  const removed = [...baseFiles].filter((rel) => !workFiles.includes(rel));
  if (removed.length > 0) {
    fail(`deleting vendor files is not supported (${removed[0]}). Empty the file instead, or say why it must go.`);
  }

  // 파일 목록을 사람이 고르지 않는다. 이 구조물이 있는 이유가 그것이다 — 손으로
  // 고르다 신규 파일이 빠져서, 그것을 import 하는 변경만 남고 런타임에서 터졌다.
  const chunks = [];
  for (const rel of workFiles.sort()) {
    const after = readFileSync(join(paths.work, rel), "utf8");
    const before = baseFiles.has(rel) ? readFileSync(join(paths.base, rel), "utf8") : "";
    if (before === after) continue;
    const chunk = fileDiff(rel, before, after);
    if (chunk) chunks.push(chunk);
  }
  if (chunks.length === 0) fail("nothing changed in the workspace");

  // UTC 로 찍는다. 정렬이 곧 적용 순서라 지역 시간대가 섞이면 순서가 흔들린다.
  const stamp = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-")}Z`;
  const name = `${stamp}-${changeId}.patch`;
  const dir = seriesDir(spec);
  const target = join(dir, name);
  if (existsSync(target)) fail(`${target} already exists`);

  const text = chunks.join("");
  // 만들자마자 우리 파서로 다시 읽는다. 여기서 걸리는 형식 오류는 나중에
  // postinstall 이 조용히 지나칠 수 있는 것들이다.
  const parsed = parseFilePatches(text, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, text);

  process.stdout.write(`${relative(process.cwd(), target)}\n`);
  for (const filePatch of parsed) process.stdout.write(`  ${filePatch.createsFile ? "new " : "    "}${filePatch.relativePath}\n`);
  process.stdout.write("\n확인:  node postinstall.mjs && bun run test:patches\n");
}

const [command, alias, ...rest] = process.argv.slice(2);
if (command === "open") open(alias, rest);
else if (command === "save") save(alias, rest[0], rest.slice(1));
else {
  process.stderr.write(
    "usage:\n" +
    "  vendor-patch open <senpi|senpi-tui|pi-ai|senpi-codemode> [--session <name>] [--force]\n" +
    "  vendor-patch save <senpi|senpi-tui|pi-ai|senpi-codemode> <change-id> [--session <name>]\n",
  );
  process.exit(2);
}
