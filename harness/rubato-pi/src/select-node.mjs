import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const MIN_MAJOR = 24;
const VERSION_IN_PATH = /(?:^|\/)v(\d+)\.(\d+)\.(\d+)(?:\/|$)/;

export function parseVersionText(text, bin) {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec((text || "").trim());
  if (!match) return null;
  return {
    bin,
    text: `v${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

// nvm 경로는 디렉터리 이름에 버전이 있다. 그 후보마다 node -v 를 띄우면
// 세션 시작이 후보 수만큼 늘어나서, 우리가 직접 나열한 nvm 루트 아래만
// 경로를 믿는다. homebrew 같은 다른 자리는 그대로 실행해 확인한다.
export function nvmVersionsRoot(home = homedir()) {
  return join(home, ".nvm/versions/node");
}

export function versionFromPath(bin, { nvmRoot = nvmVersionsRoot() } = {}) {
  const match = VERSION_IN_PATH.exec(bin);
  if (!match) return null;
  const root = nvmRoot.endsWith("/") ? nvmRoot : `${nvmRoot}/`;
  if (!bin.startsWith(root)) return null;
  return {
    bin,
    text: `v${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function canonicalBin(bin) {
  try {
    return realpathSync(bin);
  } catch {
    return bin;
  }
}

export function versionOf(bin) {
  if (!existsSync(bin)) return null;
  const resolved = canonicalBin(bin);
  const fromPath = versionFromPath(bin) ?? versionFromPath(resolved);
  if (fromPath) return { ...fromPath, bin: resolved };
  const result = spawnSync(resolved, ["-v"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return parseVersionText(result.stdout, resolved);
}

export function runningNode(proc = process) {
  if (!proc?.execPath || !existsSync(proc.execPath)) return null;
  const parsed = parseVersionText(proc?.version, canonicalBin(proc.execPath));
  if (!parsed || parsed.major < MIN_MAJOR) return null;
  return parsed;
}

export function listNodeCandidates(home = homedir(), extra = []) {
  const bins = [...extra, "/opt/homebrew/bin/node", "/usr/local/bin/node"];
  const nvmRoot = nvmVersionsRoot(home);
  if (existsSync(nvmRoot)) {
    for (const name of readdirSync(nvmRoot)) {
      if (!name.startsWith("v")) continue;
      bins.unshift(join(nvmRoot, name, "bin/node"));
    }
  }
  return bins;
}

export function pickNode(candidates, { version = versionOf } = {}) {
  const seen = new Set();
  const found = [];
  for (const bin of candidates) {
    const key = existsSync(bin) ? canonicalBin(bin) : bin;
    if (seen.has(key)) continue;
    seen.add(key);
    const parsed = version(bin);
    if (parsed && parsed.major >= MIN_MAJOR) found.push(parsed);
  }
  found.sort((a, b) => {
    if (a.major === 24 && b.major !== 24) return -1;
    if (b.major === 24 && a.major !== 24) return 1;
    return b.major - a.major || b.minor - a.minor || b.patch - a.patch;
  });
  return found[0] ?? null;
}
