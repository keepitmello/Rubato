import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, parsePatch } from "diff";

const rootDir = dirname(fileURLToPath(import.meta.url));

export const VENDOR_PATCHES = [
  {
    packageName: "@code-yeongyu/senpi",
    patchName: "@code-yeongyu%2Fsenpi@2026.8.22.patch",
    seriesName: "@code-yeongyu%2Fsenpi",
    expectedVersion: "2026.8.22",
    resolveRoot() {
      const packageLink = join(rootDir, "node_modules", "@code-yeongyu", "senpi");
      return realpathSync(packageLink);
    },
  },
  {
    packageName: "@code-yeongyu/senpi-tui (installed as @earendil-works/pi-tui)",
    patchName: "@code-yeongyu%2Fsenpi-tui@2026.8.22.patch",
    seriesName: "@code-yeongyu%2Fsenpi-tui",
    expectedVersion: "2026.8.22",
    resolveRoot() {
      const senpiRoot = VENDOR_PATCHES[0].resolveRoot();
      return realpathSync(join(senpiRoot, "node_modules", "@earendil-works", "pi-tui"));
    },
  },
  {
    packageName: "@earendil-works/pi-ai (nested in @code-yeongyu/senpi)",
    patchName: "@earendil-works%2Fpi-ai@2026.8.22.patch",
    seriesName: "@earendil-works%2Fpi-ai",
    expectedVersion: "2026.8.22",
    resolveRoot() {
      // 루트에 hoist 된 사본이 아니라 senpi 가 자기 안에 품은 사본이 세션이 읽는 것이다
      // (`engine-paths.mjs` 의 `senpiNested()` 도 이 사본을 우선한다). pi-tui 에서 같은
      // 구분을 놓치면 "패치는 정확한데 도는 것은 원본"인 상태가 오래 간다.
      const senpiRoot = VENDOR_PATCHES[0].resolveRoot();
      return realpathSync(join(senpiRoot, "node_modules", "@earendil-works", "pi-ai"));
    },
  },
  {
    packageName: "@code-yeongyu/senpi-codemode (nested in @code-yeongyu/senpi)",
    patchName: "@code-yeongyu%2Fsenpi-codemode@2026.8.22.patch",
    seriesName: "@code-yeongyu%2Fsenpi-codemode",
    expectedVersion: "2026.8.22",
    resolveRoot() {
      const senpiRoot = VENDOR_PATCHES[0].resolveRoot();
      return realpathSync(join(senpiRoot, "node_modules", "@code-yeongyu", "senpi-codemode"));
    },
  },
];

export function seriesDir(spec, root = rootDir) {
  return join(root, "patches", spec.seriesName, spec.expectedVersion);
}

/**
 * baseline 과 series 를 적용 순서대로 모은다. 각 층은 자기 이름을 달고 다닌다 —
 * 실패했을 때 어느 patch 가 걸렸는지 말할 수 있어야 한다.
 */
/**
 * 패치는 한 버전을 상대로 뜬 것이다. 다른 버전에 대면 hunk 가 안 맞아 어차피
 * 실패하는데, 그때의 메시지는 "패키지가 baseline 과 다르다"라 원인이 안 보인다.
 * 버전이 다르면 여기서 그렇게 말하고 멈춘다.
 */
export function assertExpectedVersion(spec, installedVersion) {
  if (installedVersion !== spec.expectedVersion) {
    throw new Error(
      `${spec.packageName} is ${installedVersion} but patches/ targets ${spec.expectedVersion}. ` +
      "Re-cut the patch series against the new version instead of forcing it.",
    );
  }
}

export function collectPatchLayers(spec, root = rootDir) {
  const baselinePath = join(root, "patches", spec.patchName);
  if (!existsSync(baselinePath)) throw new Error(`missing required vendor patch: ${baselinePath}`);
  const layers = [{
    name: spec.patchName,
    filePatches: parseFilePatches(readFileSync(baselinePath, "utf8"), spec.patchName),
  }];
  const dir = seriesDir(spec, root);
  if (existsSync(dir)) {
    const names = readdirSync(dir).filter((name) => name.endsWith(".patch")).sort();
    for (const name of names) {
      const label = `${spec.seriesName}/${spec.expectedVersion}/${name}`;
      layers.push({ name: label, filePatches: parseFilePatches(readFileSync(join(dir, name), "utf8"), label) });
    }
  }
  return layers;
}

/** 파일 하나에 걸리는 hunk 들을 적용 순서대로 쌓는다. */
export function stackByFile(layers) {
  const stacks = new Map();
  for (const layer of layers) {
    for (const filePatch of layer.filePatches) {
      const stack = stacks.get(filePatch.relativePath) ?? [];
      stack.push({ ...filePatch, patchName: layer.name });
      stacks.set(filePatch.relativePath, stack);
    }
  }
  return stacks;
}

function forwardThrough(source, stack) {
  let current = source;
  for (const filePatch of stack) {
    // 판정 중에는 실패가 답의 일부다. 실제 적용은 아래에서 throw 를 살려 부른다.
    let next;
    try {
      next = applyFilePatch(current, filePatch, filePatch.patchName);
    } catch {
      return false;
    }
    if (next === false) return false;
    current = next;
  }
  return current;
}

function reverseThrough(source, stack) {
  let current = source;
  for (let index = stack.length - 1; index >= 0; index--) {
    const previous = applyFilePatch(current, stack[index], stack[index].patchName, true);
    if (previous === false) return false;
    current = previous;
  }
  return current;
}

/**
 * 현재 바이트가 스택의 앞 k 개를 적용한 상태인지 찾는다. 마커를 보지 않고
 * 역적용 round-trip 으로만 판정하므로, 패치 내용이 바뀌어도 따라온다.
 * 가장 많이 적용된 상태부터 본다 — 이미 최신이면 첫 번째 시도에서 끝난다.
 */
export function locateInStack(current, stack) {
  // 신규 파일의 reverse patch 는 내용이 반복돼 있어도 마지막 복제본 하나만 지워
  // round-trip 을 통과할 수 있다. 그래서 빈 파일에서 정방향으로 만든 각 prefix와
  // 현재 바이트를 직접 비교한다. 같은 신규 파일에 후속 patch가 쌓여도 안전하다.
  if (stack[0]?.createsFile) {
    let expected = "";
    if (current === expected) return { pristine: "", applied: 0 };
    for (let k = 0; k < stack.length; k++) {
      try {
        expected = applyFilePatch(expected, stack[k], stack[k].patchName);
      } catch {
        return null;
      }
      if (current === expected) return { pristine: "", applied: k + 1 };
    }
    return null;
  }
  for (let k = stack.length; k >= 0; k--) {
    const head = stack.slice(0, k);
    const pristine = reverseThrough(current, head);
    if (pristine === false) continue;
    if (forwardThrough(pristine, head) !== current) continue;
    return { pristine, applied: k };
  }
  return null;
}

export function parseFilePatches(patchText, patchName) {
  const chunks = patchText.split(/(?=^diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  if (chunks.length === 0) throw new Error(`vendor patch ${patchName} contains no file hunks`);
  const files = chunks.map((text) => {
    const header = text.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!header || header[1] !== header[2]) {
      throw new Error(`vendor patch ${patchName} has an unsupported rename or malformed header`);
    }
    // hunk 가 없는 diff(mode 변경, 바이너리)는 적용해도 원본 그대로라, 아래 검증이
    // "이미 적용됨"으로 읽고 영구히 지나친다. 받지 않는다.
    if (!/^@@ /m.test(text)) {
      throw new Error(
        `vendor patch ${patchName}: ${header[2]} has no hunks (mode-only and binary diffs are not supported)`,
      );
    }
    return { relativePath: header[2], text, createsFile: /^--- \/dev\/null$/m.test(text) };
  });
  const duplicates = files.filter((file, index) => files.findIndex((candidate) => candidate.relativePath === file.relativePath) !== index);
  if (duplicates.length > 0) throw new Error(`vendor patch ${patchName} repeats file hunks for ${duplicates[0].relativePath}`);
  return files;
}

export function applyFilePatch(source, filePatch, patchName, reverse = false) {
  // chunk 하나에 파일이 둘 이상 들어 있으면 [0] 만 쓰는 순간 나머지가 조용히 사라진다.
  // `diff --git` 헤더를 빠뜨린 hunk 가 앞 파일에 딸려 들어오는 것이 그 경로다.
  const parsedAll = parsePatch(filePatch.text);
  if (parsedAll.length !== 1) {
    throw new Error(
      `vendor patch ${patchName}: the chunk for ${filePatch.relativePath} contains ${parsedAll.length} ` +
      'file patches. Every file needs its own "diff --git" header.',
    );
  }
  const parsed = parsedAll[0];
  if (reverse) {
    for (const hunk of parsed.hunks) {
      [hunk.oldStart, hunk.newStart] = [hunk.newStart, hunk.oldStart];
      [hunk.oldLines, hunk.newLines] = [hunk.newLines, hunk.oldLines];
      hunk.lines = hunk.lines.map((line) => line.startsWith("+") ? `-${line.slice(1)}` : line.startsWith("-") ? `+${line.slice(1)}` : line);
    }
  }
  const result = applyPatch(source, parsed, { fuzzFactor: 0 });
  if (result === false && !reverse) {
    throw new Error(
      `cannot apply ${patchName} to ${filePatch.relativePath}; ` +
      "the installed package no longer matches the pristine baseline. Regenerate the patch from npm pack, not node_modules.",
    );
  }
  return result;
}

function applyAndVerifyVendorPatch(spec) {
  const packageRoot = spec.resolveRoot();
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  // 패치는 한 버전을 상대로 뜬 것이다. 다른 버전에 대면 hunk 가 안 맞아 어차피
  // 실패하는데, 그때의 메시지는 "패키지가 baseline 과 다르다"라 원인이 안 보인다.
  // 버전이 다르면 여기서 그렇게 말하고 멈춘다.
  assertExpectedVersion(spec, manifest.version);

  const layers = collectPatchLayers(spec);
  const stacks = stackByFile(layers);
  const writes = [];

  for (const [relativePath, stack] of stacks) {
    const targetPath = join(packageRoot, relativePath);
    const source = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
    const located = locateInStack(source, stack);
    if (located === null) {
      throw new Error(
        `cannot place ${relativePath} in the patch series for ${spec.packageName}; ` +
        "the installed file matches neither the pristine baseline nor any prefix of the series. " +
        "Reinstall the package instead of editing node_modules.",
      );
    }
    if (located.applied === stack.length) continue;

    // 남은 층을 순서대로 얹는다. 여기서의 실패는 삼키지 않는다 — 같은 원본 줄을
    // 두 patch 가 건드리면 여기서 멈춰야 조용한 손실이 안 생긴다. 자동 병합은
    // 하지 않는다. 무엇이 어디서 부딪혔는지 말하고 사람에게 돌려준다.
    let contents = located.pristine;
    for (const [index, filePatch] of stack.entries()) {
      try {
        contents = applyFilePatch(filePatch.createsFile && contents === "" ? "" : contents, filePatch, filePatch.patchName);
      } catch (error) {
        if (index === 0) throw error;
        throw new Error(
          `${filePatch.patchName} does not apply to ${relativePath} on top of ${stack[index - 1].patchName}. ` +
          "Two patches in the series change the same lines. Open a fresh workspace " +
          "(`node harness/scripts/vendor-patch.mjs open <pkg>`), redo this change on top of the current " +
          "series, and save it as a new patch. Do not edit the existing patch.",
        );
      }
    }
    writes.push({ targetPath, contents });
  }

  for (const write of writes) {
    mkdirSync(dirname(write.targetPath), { recursive: true });
    writeFileSync(write.targetPath, write.contents);
  }

  for (const [relativePath, stack] of stacks) {
    const targetPath = realpathSync(join(packageRoot, relativePath));
    const patched = readFileSync(targetPath, "utf8");
    const located = locateInStack(patched, stack);
    if (located === null || located.applied !== stack.length) {
      throw new Error(`realpath verification failed for ${targetPath}`);
    }
  }
  const seriesCount = layers.length - 1;
  const suffix = seriesCount > 0 ? ` +${seriesCount} series patch${seriesCount === 1 ? "" : "es"}` : "";
  console.log(`✓ verified ${spec.packageName}@${manifest.version} at ${realpathSync(packageRoot)}${suffix}`);
}

function applyVendorPatches() {
  for (const spec of VENDOR_PATCHES) applyAndVerifyVendorPatch(spec);
}
function main() {
  applyVendorPatches();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
