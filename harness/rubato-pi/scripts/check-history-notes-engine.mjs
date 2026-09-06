import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Run WITHOUT --import. This calls the production loader on actual installed
// source but does not execute vendor code or send any model request.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const harness = join(root, "harness/rubato-pi");
process.env.RUBATO_CONTEXT_MODE = "history-notes";
const packagePath = join(root, "node_modules/@code-yeongyu/senpi/package.json");
try {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("로컬 검증에는 저장소가 요구하는 Node 24 이상이 필요해요.");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  if (pkg.version !== "2026.9.4-3") throw new Error(`엔진 버전이 달라요: ${pkg.version}; 기준은 2026.9.4-3이에요.`);
  const { load } = await import(pathToFileURL(join(harness, "src/no-changelog-hooks.mjs")));
  const targets = [
    ["settings", "node_modules/@code-yeongyu/senpi/dist/core/settings-manager.js"],
    ["messages", "node_modules/@code-yeongyu/senpi/dist/core/messages.js"],
    ["session", "node_modules/@code-yeongyu/senpi/dist/core/agent-session.js"],
    ["lane", "node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/lane-policy.js"],
    ["pipeline", "node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/context-pipeline.js"],
    ["anthropic", "harness/rubato-pi/src/anthropic-server-compaction.mjs"],
  ];
  const checked = [];
  for (const [part, path] of targets) {
    const absolute = join(root, path);
    const source = readFileSync(absolute, "utf8");
    const result = await load(pathToFileURL(absolute).href, {}, async () => ({ source, format: "module" }));
    const transformed = String(result.source);
    if (!transformed.includes(`rubato-history-notes-transform-v2:${part}`)) throw new Error(`필수 연결이 빠졌어요: ${part}`);
    const parse = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: transformed, encoding: "utf8" });
    if (parse.error) throw parse.error;
    if (parse.status !== 0) throw new Error(`${path}\n${parse.stderr}`);
    checked.push({ part, path, syntax: "passed", changed: source !== transformed });
  }
  console.log(JSON.stringify({ engine: pkg.version, criticalTransforms: "passed", checked,
    remaining: "실제 AgentSession 도구 반복·공급자 요청·화면 검증은 별도로 실행해야 해요." }, null, 2));
} catch (error) {
  console.error(error.stack ?? error.message ?? String(error)); process.exitCode = 1;
}
