#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const manifestPath = path.join(packageDir, "skill-bundle.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const sourceRoot = path.resolve(packageDir, manifest.source);
const installedRoot = path.resolve(packageDir, manifest.output);
const excluded = manifest.excludedPatterns.map((pattern) => new RegExp(pattern));

const managedNames = [...manifest.managed, ...manifest.conditional].sort();
const sourceNames = [
  ...managedNames,
  ...manifest.preserved,
].sort();

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isExcluded(relativePath) {
  const normalized = toPosix(relativePath);
  return excluded.some((pattern) => pattern.test(normalized));
}

function outputName(sourceName) {
  return manifest.renames[sourceName] ?? sourceName;
}

function transformText(relativePath, input) {
  let output = input
    .replaceAll("/Users/wy/Github-repos/god-tibo-imagen", "${GOD_TIBO_IMAGEN_REPO}")
    .replaceAll("/Users/wy/.local/bin/gti", "gti")
    .replaceAll("/Users/wy/.claude/roo-channel/tools/wan26", "${WAN26_HOME}")
    .replaceAll("/Users/wy", "<mac-home>")
    .replaceAll("~/.agents/skills", "${CODEX_HOME:-$HOME/.codex}/skills");

  if (relativePath === "aside-browser/SKILL.md") {
    output = output.replace("name: \"aside-browser\"\nversion: 4", "name: \"aside-browser\"\nmetadata:\n  version: \"4\"");
  }

  if (relativePath === "metaFrame/SKILL.md") {
    output = output
      .replace("name: metaFrame", "name: metaframe")
      .replace("disable-model-invocation: true\nargument-hint: \"[task or current work]\"\n", "");
  }

  if (relativePath === "agent-taskforce/references/01-operating-model.md") {
    output = output
      .replace(
        "The human operator owns the framing choice, lead-model choice, and the veto over the roster. Report a new or materially changed teammate before it starts; wait for explicit confirmation only when the spawn commits something hard to take back or the operator has asked to approve teams. Recreating the same teammate after session loss is recovery, not a new staffing decision.",
        "The human operator owns the framing choice and lead-model choice. Before forming a team, the lead presents the outcome, role, model and effort roster and waits for explicit confirmation. Recreating the same teammate after session loss, or correcting the same already approved work, stays under that confirmation. A new or materially changed teammate or roster requires confirmation before spawn.",
      )
      .replace(
        "| initial teammate spawn | lead, after reporting the roster; human veto |",
        "| initial teammate spawn | lead, after explicit roster confirmation |",
      )
      .replace(
        "| material restaffing or new teammate | lead reports before spawn; human veto |",
        "| material restaffing or new teammate | lead, after explicit roster confirmation |",
      );
  }

  if (relativePath === "agent-taskforce/references/05-prompting-contracts.md") {
    output = output.replace(
      "Skill(model-guide) contains the current soft roster and the bottleneck-based selection guide; `references/08-model-allocation.md` holds only the team proposal format.",
      "The bundled [model-guide](../../model-guide/SKILL.md) is the model and approval SSOT; [model allocation](model-allocation.md) keeps only the team-specific pointer.",
    );
  }

  if (relativePath === "frontend-ux-router/MAINTENANCE.md") {
    output = output.replace('git add -A && git commit -m "<what failure this addresses>" \n', 'git add -A && git commit -m "<what failure this addresses>"\n');
  }

  if (relativePath === "frontend-ux-router/references/software-ux-research/references/customer-journey-mapping.md") {
    output = output.replaceAll("======= LINE OF INTERACTION =======", "------- LINE OF INTERACTION -------")
      .replaceAll("======= LINE OF VISIBILITY =======", "------- LINE OF VISIBILITY -------")
      .replaceAll("======= LINE OF INTERNAL =======", "------- LINE OF INTERNAL -------");
  }

  if (relativePath === "humanize-korean/references/rewriting-playbook.md") {
    output = output.replace('- **기계적 병렬 "첫째/둘째/셋째"**: \n', '- **기계적 병렬 "첫째/둘째/셋째"**:\n');
  }

  if (relativePath.startsWith("insane-search/")) {
    output = output
      .replaceAll("mcp__playwright__*", "an advertised Playwright/browser tool")
      .replaceAll("the Claude session", "the Codex session")
      .replaceAll("Claude session", "Codex session");
  }

  if (relativePath === "insane-search/SKILL.md") {
    output = output.replace(
      /<!-- first-run setup:[\s\S]*?# Insane Search/,
      "# Insane Search",
    );
    output = output
      .replaceAll("## 하네스 규칙 (Claude에게 강제되는 지침)", "## Codex 실행 규칙")
      .replaceAll("이 규칙은 Claude가", "이 규칙은 Codex가")
      .replaceAll("Claude가 세션에서 직접", "Codex가 현재 세션에서 직접")
      .replaceAll("Claude 세션에서", "Codex 세션에서")
      .replaceAll("Claude가 직접 처리", "Codex가 직접 처리")
      .replaceAll("Claude는 필요할 때만", "Codex는 필요할 때만")
      .replaceAll("${CLAUDE_PLUGIN_ROOT}/skills/insane-search", "${CODEX_HOME:-$HOME/.codex}/skills/insane-search")
      .replaceAll("Playwright MCP (`mcp__playwright__*`)", "an advertised Playwright/browser tool")
      .replaceAll("Playwright MCP 호출 규칙", "브라우저 도구 호출 규칙")
      .replaceAll("Playwright MCP must be invoked from the Claude session", "a browser tool must be invoked from the Codex session")
      .replaceAll("`mcp__playwright__browser_navigate` → `browser_wait_for` → `browser_snapshot`", "현재 런타임이 실제로 제공하는 브라우저 도구로 navigate → wait → snapshot")
      .replaceAll("`mcp__playwright__*`: Cloudflare급 챌린지", "런타임이 제공하는 browser tool: Cloudflare급 챌린지");

    output = output
      .replaceAll("python3 -m engine", "python3 \"${CODEX_HOME:-$HOME/.codex}/skills/insane-search/engine\"")
      .replaceAll("python3 engine/bias_check.py", "python3 \"${CODEX_HOME:-$HOME/.codex}/skills/insane-search/engine/bias_check.py\"")
      .replaceAll("python3 tests/coverage_battery.py", "python3 \"${CODEX_HOME:-$HOME/.codex}/skills/insane-search/tests/coverage_battery.py\"")
      .replace(
        "from insane_search.engine import fetch",
        "import os, sys\nskill_dir = os.path.join(os.environ.get(\"CODEX_HOME\", os.path.expanduser(\"~/.codex\")), \"skills\", \"insane-search\")\nsys.path.insert(0, skill_dir)\nfrom engine import fetch",
      )
      .replace(
        "## 의존성 자동 설치\n\n최초 호출 시 필요 패키지를 자동 설치한다.",
        "## 의존성 준비\n\n번들은 패키지를 자동 설치하지 않는다. 먼저 아래 import 검사를 실행하고, 누락 패키지 설치는 현재 작업의 권한과 환경을 확인한 뒤에만 진행한다.",
      )
      .replace(
        "`protocol_stealth_chrome`는 `pip install nodriver`(또는 patchright)가 필요하다. 없으면 다음 fallback으로 진행하며, `INSANE_AUTO_INSTALL=1`이면 첫 호출 시 자동 설치.",
        "`protocol_stealth_chrome`는 `nodriver`(또는 patchright)가 필요하다. 없으면 다음 fallback으로 진행한다. `INSANE_AUTO_INSTALL=1`은 현재 작업이 의존성 설치를 명시적으로 허용한 경우에만 사용한다.",
      );

    output = output.replace(
      "3. `must_invoke_playwright_mcp=false`: true면 **Codex가 현재 세션에서 직접** MCP Playwright를 돌린 뒤에만 통과: `browser_navigate` → `browser_snapshot`으로 렌더된 공개 페이지 본문(HTML)을 회수한다. (engine은 로컬 Node Chrome만 띄울 수 있고 MCP는 못 돌리므로, MCP는 **구조적으로** 에이전트의 몫이다.)",
      "3. `must_invoke_playwright_mcp=false`: true면 현재 Codex 런타임에 실제로 광고된 Playwright/browser 도구로 렌더된 공개 페이지 본문을 회수한 뒤에만 통과한다. 해당 도구가 없으면 그 한계를 보고하고 멈춘다. 엔진 결과만으로 전수 시도를 주장하지 않는다.",
    );

    output = output.replace(
      "# Insane Search\n",
      "# Insane Search\n\n이 번들에는 Claude 플러그인 설치·별점 요청 단계가 없다. 엔진은 설치된 스킬 디렉터리에서 실행하며, 런타임이 광고하지 않은 MCP 도구 이름을 추측하지 않는다.\n",
    );
  }

  if (relativePath === "return/SKILL.md") {
    output = `---
name: return
description: "Reference contract for Rubato non-interactive worker stdout. Do not use it to replace Codex native final responses."
---

# Rubato worker return contract

This packaged source is conditional documentation for a process launched by
\`rubato dispatch\` in non-interactive print or JSON mode. It does not change
Codex native completion, messaging, or final-response behavior. Ignore this
skill unless the current task is explicitly implementing or operating that
Rubato worker path.

When it applies, keep worker stdout to one actionable executive layer: outcome,
client decision, approvals still required, and evidence-file paths. Put detailed
commands, changes, rationale, and logs in the Rubato session's detail file. Use
\`RUBATO_RETURN_DETAIL\` only when the caller explicitly supplies it. If the
detail file cannot be written, report that and stop rather than flooding stdout.
`;
  }

  if (relativePath === "rubato-tui-verify/SKILL.md") {
    output = output
      .replace(
        'description: "Verify Rubato/senpi TUI rendering: thinking block collapse/expand, tool output, mouse toggles. Check the component layer before launching a session."',
        'description: "Conditionally verify Rubato or Senpi TUI source rendering. This is a repository workflow, not a replacement for Codex native UI or sessions."',
      )
      .replace(
        "# Rubato TUI Verify",
        "# Rubato TUI Verify\n\n이 스킬은 현재 작업 대상이 Rubato/Senpi TUI 소스일 때만 쓴다. Codex 자체 세션·터미널·UI를 대체하거나 별도 Rubato 세션 관리자를 띄우는 용도가 아니다.",
      )
      .replaceAll("~/.agents/skills/rubato-tui-verify", "${CODEX_HOME:-$HOME/.codex}/skills/rubato-tui-verify")
      .replace(
        /## 3층: 실세션[\s\S]*?## 판정할 때/,
        "## 3층: 실세션\n\n실세션은 현재 Codex 런타임이 제공하는 터미널 표면에서만 띄운다. 별도 세션 관리자나 런타임을 대체하지 말고, 자신이 만든 정확한 프로세스 식별자만 종료한다. 컴포넌트와 입력 테스트로 답이 나왔으면 생략한다.\n\n## 판정할 때",
      );
  }

  if (relativePath === "wrapping-sessions/SKILL.md") {
    output = `---
name: wrapping-sessions
description: "Reference-only Rubato session wrap format. Use only when the user or repository explicitly asks for a wrap; never auto-commit from Codex."
---

# Rubato session wrap reference

This source workflow is packaged for compatibility, but it is not an active
Codex completion hook. Use it only when the user or repository explicitly asks
for a durable session wrap. Do not create private case-study paths, stage files,
or commit merely because a Codex turn is ending.

When explicitly requested, preserve the facts that a diff cannot recover:
decision rationale, rejected approaches and why, external answers, reversed
assumptions, unresolved findings, verification actually run, and the exact next
action. Separate confirmed facts from estimates. Follow the current repository's
chosen destination, language, commit policy, and ownership boundaries; if no
destination is specified, ask rather than inventing a private path.
`;
  }

  return output;
}

async function listTree(root, relative = "") {
  const absolute = path.join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(relative, entry.name);
    if (isExcluded(child)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink escapes are not bundleable: ${toPosix(child)}`);
    }
    if (entry.isDirectory()) files.push(...await listTree(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function copyFileTransformed(source, destination, relativePath) {
  const data = await readFile(source);
  let output = data;
  if (!data.includes(0)) {
    output = Buffer.from(transformText(toPosix(relativePath), data.toString("utf8")));
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, output);
  const sourceStat = await stat(source);
  await chmod(destination, sourceStat.mode & 0o777);
}

async function copySkill(name, outputRoot) {
  const source = path.join(sourceRoot, name);
  const destination = path.join(outputRoot, outputName(name));
  const files = await listTree(source);
  assert(files.includes("SKILL.md"), `${name} has no SKILL.md`);
  if (outputName(name) !== name) {
    await rm(path.join(outputRoot, name), { recursive: true, force: true });
  }
  await rm(destination, { recursive: true, force: true });
  for (const relative of files) {
    await copyFileTransformed(
      path.join(source, relative),
      path.join(destination, relative),
      path.join(name, relative),
    );
  }
}

async function copySupplemental(outputRoot) {
  for (const [name, files] of Object.entries(manifest.supplemental)) {
    for (const relative of [...files].sort()) {
      assert(!isExcluded(relative), `supplemental file is excluded: ${name}/${relative}`);
      await copyFileTransformed(
        path.join(sourceRoot, name, relative),
        path.join(outputRoot, name, relative),
        path.join(name, relative),
      );
    }
  }
}

async function verifyInventory() {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const actual = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actual, sourceNames, "skill-bundle.json must account for every source skill");
  const overlap = managedNames.filter((name) => manifest.preserved.includes(name));
  assert.deepEqual(overlap, [], "managed/conditional skills cannot also be preserved");
}

async function comparableFiles(root, names) {
  const results = new Map();
  for (const name of names) {
    const destinationName = outputName(name);
    for (const relative of await listTree(path.join(root, destinationName))) {
      results.set(toPosix(path.join(destinationName, relative)), await readFile(path.join(root, destinationName, relative)));
    }
  }
  for (const [name, files] of Object.entries(manifest.supplemental)) {
    for (const relative of files) {
      results.set(toPosix(path.join(name, relative)), await readFile(path.join(root, name, relative)));
    }
  }
  return results;
}

async function assertSame(expectedRoot, actualRoot) {
  const expected = await comparableFiles(expectedRoot, managedNames);
  const actual = await comparableFiles(actualRoot, managedNames);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), "generated skill file list drifted");
  for (const [relative, expectedData] of expected) {
    assert(actual.get(relative)?.equals(expectedData), `generated skill drifted: ${relative}`);
  }
}

await verifyInventory();

if (process.argv.includes("--check")) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "rubato-codex-skills-"));
  try {
    for (const name of managedNames) await copySkill(name, temporary);
    await copySupplemental(temporary);
    await assertSame(temporary, installedRoot);
    process.stdout.write(`skills bundle is current (${sourceNames.length} source skills accounted for)\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else {
  await mkdir(installedRoot, { recursive: true });
  for (const name of managedNames) await copySkill(name, installedRoot);
  await copySupplemental(installedRoot);
  process.stdout.write(`built ${managedNames.length} managed skills; preserved ${manifest.preserved.length} Codex-owned source skills\n`);
}
