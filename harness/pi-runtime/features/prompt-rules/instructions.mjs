import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
} from "node:path";

const PROJECT_MARKERS = Object.freeze([
  ".git",
  "pnpm-workspace.yaml",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  ".venv",
]);
const PROJECT_RULE_SUBDIRS = Object.freeze([
  [".omo", "rules"],
  [".claude", "rules"],
  [".cursor", "rules"],
  [".github", "instructions"],
]);
const PROJECT_SINGLE_FILES = Object.freeze([
  ".github/copilot-instructions.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
]);
const USER_RULE_SUBDIRS = Object.freeze([".omo/rules", ".opencode/rules", ".claude/rules"]);
const USER_SINGLE_FILES = Object.freeze([".config/opencode/AGENTS.md", ".claude/CLAUDE.md"]);
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next", "coverage"]);
const SOURCE_PRIORITY = new Map([
  [".omo/rules", 0],
  [".claude/rules", 1],
  [".cursor/rules", 2],
  [".github/instructions", 3],
  [".github/copilot-instructions.md", 4],
  ["AGENTS.md", 5],
  ["CLAUDE.md", 6],
  ["CONTEXT.md", 7],
  ["~/.omo/rules", 100],
  ["~/.opencode/rules", 101],
  ["~/.claude/rules", 102],
  ["~/.config/opencode/AGENTS.md", 103],
  ["~/.claude/CLAUDE.md", 104],
]);
const ROOT_SINGLE_FILES = new Set(["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]);
const RULE_FILE_EXTENSIONS = Object.freeze([".md", ".mdc"]);
const RULE_MODES = new Set(["static", "dynamic", "both", "off"]);
const TRACKED_TOOLS = new Set(["read", "edit", "write"]);
const DEFAULT_MAX_RULE_CHARS = 12_000;
const DEFAULT_MAX_RESULT_CHARS = 40_000;
const DEFAULT_MAX_AGENTS_BYTES = 32 * 1024;
const DEFAULT_MAX_AGENTS_PER_READ = 128 * 1024;
const PROJECT_RULES_REGION_START = "<!--senpi:project-rules:1:start-->";
const PROJECT_RULES_REGION_END = "<!--senpi:project-rules:1:end-->";

function truthy(value) {
  return typeof value === "string" && new Set(["1", "true", "yes", "on"]).has(value.trim().toLowerCase());
}

function positiveInteger(value, fallback) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function canonical(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findProjectRoot(startPath) {
  const start = resolve(startPath);
  if (!existsSync(start)) return null;
  let current;
  try {
    current = statSync(start).isDirectory() ? start : dirname(start);
  } catch {
    return null;
  }
  while (true) {
    if (PROJECT_MARKERS.some((marker) => existsSync(join(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function walkDirectories(projectRoot, targetPath) {
  if (!targetPath) return [{ directory: projectRoot, distance: 0 }];
  const start = dirname(resolve(targetPath));
  if (!isWithin(projectRoot, start)) return [{ directory: projectRoot, distance: 0 }];
  const result = [];
  let current = start;
  let distance = 0;
  while (true) {
    result.push({ directory: current, distance });
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    distance += 1;
  }
  return result;
}

function scanRuleFiles(rootDir, depth = 0, visited = new Set()) {
  if (!existsSync(rootDir) || depth > 10) return [];
  let realDir;
  let entries;
  try {
    realDir = realpathSync.native(rootDir);
    if (visited.has(realDir) || !statSync(rootDir).isDirectory()) return [];
    visited.add(realDir);
    entries = readdirSync(rootDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) files.push(...scanRuleFiles(path, depth + 1, visited));
      continue;
    }
    if (entry.isSymbolicLink()) {
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
        files.push(...scanRuleFiles(path, depth + 1, visited));
      } else if (stats.isFile() && RULE_FILE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        files.push(path);
      }
      continue;
    }
    if (entry.isFile() && RULE_FILE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(path);
    }
  }
  return files;
}

function existingFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function projectCandidates(projectRoot, targetPath) {
  const candidates = [];
  for (const walk of walkDirectories(projectRoot, targetPath)) {
    for (const [parent, child] of PROJECT_RULE_SUBDIRS) {
      const source = `${parent}/${child}`;
      for (const path of scanRuleFiles(join(walk.directory, parent, child))) {
        candidates.push({
          path,
          realPath: canonical(path),
          relativePath: relative(projectRoot, path).replaceAll("\\", "/"),
          source,
          distance: targetPath ? walk.distance : 0,
          isGlobal: false,
          isSingleFile: false,
          scopeDirectory: walk.directory,
        });
      }
    }
  }
  for (const walk of walkDirectories(projectRoot, targetPath)) {
    for (const name of PROJECT_SINGLE_FILES) {
      const path = join(walk.directory, name);
      if (!existingFile(path)) continue;
      candidates.push({
        path,
        realPath: canonical(path),
        relativePath: relative(projectRoot, path).replaceAll("\\", "/"),
        source: name,
        distance: targetPath ? walk.distance : 0,
        isGlobal: false,
        isSingleFile: true,
        scopeDirectory: walk.directory,
      });
    }
  }
  return candidates;
}

function userCandidates(homeDir) {
  const candidates = [];
  for (const name of USER_RULE_SUBDIRS) {
    for (const path of scanRuleFiles(join(homeDir, name))) {
      candidates.push({
        path,
        realPath: canonical(path),
        relativePath: relative(homeDir, path).replaceAll("\\", "/"),
        source: `~/${name}`,
        distance: 9999,
        isGlobal: true,
        isSingleFile: false,
      });
    }
  }
  for (const name of USER_SINGLE_FILES) {
    const path = join(homeDir, name);
    if (!existingFile(path)) continue;
    candidates.push({
      path,
      realPath: canonical(path),
      relativePath: relative(homeDir, path).replaceAll("\\", "/"),
      source: `~/${name}`,
      distance: 9999,
      isGlobal: true,
      isSingleFile: true,
    });
  }
  return candidates;
}

function compareCandidates(left, right) {
  return Number(left.isGlobal) - Number(right.isGlobal)
    || left.distance - right.distance
    || (SOURCE_PRIORITY.get(left.source) ?? Infinity) - (SOURCE_PRIORITY.get(right.source) ?? Infinity)
    || left.relativePath.localeCompare(right.relativePath)
    || left.realPath.localeCompare(right.realPath);
}

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = quote === character ? null : (quote ?? character);
      continue;
    }
    if (!quote && character === "#") return line.slice(0, index);
  }
  return line;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function parseGlobValue(raw, lines, index) {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return {
      values: value.slice(1, -1).split(",").map(parseScalar).filter(Boolean),
      consumed: 1,
    };
  }
  if (value) return { values: value.split(",").map(parseScalar).filter(Boolean), consumed: 1 };
  const values = [];
  let consumed = 1;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const match = stripComment(lines[cursor] ?? "").match(/^\s+-\s*(.*)$/);
    if (!match) break;
    values.push(parseScalar(match[1] ?? ""));
    consumed += 1;
  }
  return { values: values.filter(Boolean), consumed };
}

export function parseRule(content) {
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const lines = normalized.replaceAll("\r\n", "\n").split("\n");
  const closing = lines.indexOf("---", 1);
  if (closing < 0) return { frontmatter: {}, body: normalized, diagnostic: "Missing closing frontmatter delimiter" };
  const frontmatter = {};
  const globs = [];
  for (let index = 1; index < closing;) {
    const line = stripComment(lines[index] ?? "").trim();
    if (!line) {
      index += 1;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      index += 1;
      continue;
    }
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1);
    if (key === "alwaysApply") frontmatter.alwaysApply = raw.trim() === "true";
    if (key === "description") frontmatter.description = parseScalar(raw);
    if (key === "globs" || key === "paths" || key === "applyTo") {
      const parsed = parseGlobValue(raw, lines.slice(0, closing), index);
      globs.push(...parsed.values);
      index += parsed.consumed;
      continue;
    }
    index += 1;
  }
  if (globs.length === 1) frontmatter.globs = globs[0];
  if (globs.length > 1) frontmatter.globs = [...new Set(globs)];
  return { frontmatter, body: lines.slice(closing + 1).join("\n") };
}

function normalizedGlobs(frontmatter) {
  const value = frontmatter.globs;
  if (typeof value === "string") return [value.replaceAll("\\", "/")];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").map((item) => item.replaceAll("\\", "/"));
  return [];
}

function matchesRule(rule, targetPath, projectRoot) {
  if (rule.isSingleFile || rule.frontmatter.alwaysApply === true) return true;
  const patterns = normalizedGlobs(rule.frontmatter);
  if (patterns.length === 0) return false;
  const bases = [
    relative(projectRoot ?? dirname(targetPath), targetPath).replaceAll("\\", "/"),
    rule.scopeDirectory ? relative(rule.scopeDirectory, targetPath).replaceAll("\\", "/") : undefined,
    basename(targetPath),
  ].filter(Boolean);
  const negatives = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  for (const pattern of patterns.filter((candidate) => !candidate.startsWith("!"))) {
    for (const base of bases) {
      if (matchesGlob(base, pattern) && !negatives.some((negative) => matchesGlob(base, negative))) return true;
    }
  }
  return false;
}

function loadCandidates({ cwd, targetPath, homeDir, staticLoad, nativePaths = new Set() }) {
  const projectRoot = findProjectRoot(targetPath ?? cwd);
  const candidates = [
    ...(projectRoot ? projectCandidates(projectRoot, targetPath) : []),
    ...userCandidates(homeDir),
  ].sort(compareCandidates);
  const loaded = [];
  const seen = new Set();
  let rootSingleSelected = false;
  for (const candidate of candidates) {
    if (!candidate.isGlobal && projectRoot && !isWithin(canonical(projectRoot), candidate.realPath)) continue;
    const isRootSingle = !candidate.isGlobal && candidate.distance === 0
      && candidate.isSingleFile && ROOT_SINGLE_FILES.has(candidate.source);
    if (staticLoad && isRootSingle && rootSingleSelected) continue;
    let content;
    try {
      content = readFileSync(candidate.path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseRule(content);
    const rule = { ...candidate, ...parsed, contentHash: hash(content) };
    const matched = staticLoad
      ? rule.frontmatter.alwaysApply === true || rule.isSingleFile
      : matchesRule(rule, targetPath, projectRoot);
    if (!matched) continue;
    if (isRootSingle) rootSingleSelected = true;
    if (candidate.source === "AGENTS.md" || nativePaths.has(candidate.path) || nativePaths.has(candidate.realPath)) continue;
    const key = `${candidate.realPath}\0${rule.contentHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    loaded.push(rule);
  }
  return loaded;
}

function truncateRule(rule, maxChars) {
  if (rule.body.length <= maxChars) return rule.body;
  const notice = `\n\n[Rule truncated. Read full rule: ${rule.relativePath}]`;
  return `${rule.body.slice(0, Math.max(0, maxChars - notice.length))}${notice}`;
}

function budgetRules(rules, maxRuleChars, maxResultChars) {
  const result = [];
  let used = 0;
  for (const rule of rules) {
    const body = truncateRule(rule, maxRuleChars);
    const rendered = `Instructions from: ${rule.path}\n${body}`;
    if (used + rendered.length > maxResultChars) break;
    result.push(rendered);
    used += rendered.length;
  }
  return result;
}

function neutralizeMarkers(text) {
  return text
    .replaceAll(PROJECT_RULES_REGION_START, "&lt;!--senpi:project-rules:1:start--&gt;")
    .replaceAll(PROJECT_RULES_REGION_END, "&lt;!--senpi:project-rules:1:end--&gt;")
    .replaceAll("<project_rules>", "&lt;project_rules&gt;")
    .replaceAll("</project_rules>", "&lt;/project_rules&gt;");
}

function formatStatic(rules, config) {
  const rendered = budgetRules(rules, config.maxRuleChars, config.maxResultChars);
  if (rendered.length === 0) return "";
  const body = neutralizeMarkers(`## Project Instructions\n${rendered.join("\n\n")}`);
  return `\n\n${PROJECT_RULES_REGION_START}\n<project_rules>\n${body}\n</project_rules>\n${PROJECT_RULES_REGION_END}`;
}

function formatDynamic(rules, targetPath, cwd, config) {
  const rendered = budgetRules(rules, config.maxRuleChars, config.maxResultChars);
  if (rendered.length === 0) return "";
  const display = isWithin(cwd, targetPath) ? relative(cwd, targetPath) : targetPath;
  return `\n\nAdditional project instructions matched for ${display}:\n\n${rendered.join("\n\n")}`;
}

function sessionKey(ctx) {
  return ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId?.() ?? "__rubato_prompt_rules_singleton__";
}

async function containedTarget(rootDir, inputPath) {
  if (!inputPath) return null;
  const resolved = isAbsolute(inputPath) ? inputPath : resolve(rootDir, inputPath);
  try {
    const [root, target] = await Promise.all([realpath(rootDir), realpath(resolved)]);
    return target !== root && isWithin(root, target) ? { root, target } : null;
  } catch {
    return null;
  }
}

function truncateUtf8(content, maxBytes) {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength <= maxBytes) return { text: content, bytes: bytes.byteLength, truncated: false };
  let text = new TextDecoder("utf8").decode(bytes.subarray(0, maxBytes));
  while (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return { text, bytes: new TextEncoder().encode(text).byteLength, truncated: true };
}

async function nestedAgentsBlocks({ rootDir, inputPath, injectedDirectories }) {
  const contained = await containedTarget(rootDir, inputPath);
  if (!contained) return [];
  const candidates = [];
  let current = dirname(contained.target);
  while (current !== contained.root && isWithin(contained.root, current)) {
    const path = join(current, "AGENTS.md");
    if (existingFile(path)) candidates.push(path);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  candidates.reverse();
  const blocks = [];
  let budget = DEFAULT_MAX_AGENTS_PER_READ;
  for (const path of candidates) {
    const directory = dirname(path);
    if (injectedDirectories.has(directory) || budget <= 0) continue;
    try {
      const content = await readFile(path, "utf8");
      const truncated = truncateUtf8(content, Math.min(DEFAULT_MAX_AGENTS_BYTES, budget));
      const notice = truncated.truncated
        ? `\n\n[Note: Content was truncated to save context window space. For full context, please read the file directly: ${path}]`
        : "";
      blocks.push(`\n\n[Directory Context: ${path}]\n${truncated.text}${notice}`);
      injectedDirectories.add(directory);
      budget -= truncated.bytes;
    } catch {
      // Match Senpi's non-fatal injection behavior: the tool result still returns.
    }
  }
  return blocks;
}

function extractToolPaths(event, cwd) {
  if (event.isError || !TRACKED_TOOLS.has(event.toolName)) return [];
  const values = event.toolName === "write"
    ? [event.input?.filePath, event.input?.path]
    : [event.details?.filePath, event.input?.path];
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => isAbsolute(value) ? value : resolve(cwd, value)))];
}

function nativeContextPaths(event) {
  const paths = new Set();
  for (const file of event.systemPromptOptions?.contextFiles ?? []) {
    if (typeof file.path !== "string") continue;
    paths.add(file.path);
    paths.add(canonical(file.path));
  }
  return paths;
}

export function createInstructionExtension({ settingsManager, env = process.env } = {}) {
  if (!settingsManager) throw new TypeError("instruction extension requires SettingsManager");
  return (pi) => {
    pi.registerFlag("no-nested-agents", {
      description: "Disable nested AGENTS.md context injection.",
      type: "boolean",
      default: false,
    });
    pi.registerFlag("pi-rules-disabled", {
      description: "Disable pi-rules hooks.",
      type: "boolean",
      default: false,
    });
    pi.registerFlag("pi-rules-mode", {
      description: "Rule injection mode: static, dynamic, both, or off.",
      type: "string",
      default: "both",
    });

    const injectedBySession = new Map();
    const staticInjected = new Set();
    const dynamicInjected = new Set();
    let latestRules = [];
    const config = {
      maxRuleChars: positiveInteger(env.PI_RULES_MAX_RULE_CHARS, DEFAULT_MAX_RULE_CHARS),
      maxResultChars: positiveInteger(env.PI_RULES_MAX_RESULT_CHARS, DEFAULT_MAX_RESULT_CHARS),
    };
    const homeDir = resolve(env.HOME || env.USERPROFILE || homedir());

    const ruleMode = () => {
      if (truthy(env.PI_RULES_DISABLED) || pi.getFlag("pi-rules-disabled") === true) return "off";
      const value = pi.getFlag("pi-rules-mode");
      return typeof value === "string" && RULE_MODES.has(value) ? value : "both";
    };
    const reset = () => {
      injectedBySession.clear();
      staticInjected.clear();
      dynamicInjected.clear();
      latestRules = [];
    };

    pi.on("session_start", reset);
    pi.on("session_compact", reset);
    pi.on("session_shutdown", reset);

    pi.on("before_agent_start", async (event, ctx) => {
      const mode = ruleMode();
      if (mode === "off" || mode === "dynamic") return undefined;
      const rules = loadCandidates({
        cwd: ctx.cwd,
        targetPath: null,
        homeDir,
        staticLoad: true,
        nativePaths: nativeContextPaths(event),
      });
      latestRules = rules;
      for (const rule of rules) staticInjected.add(`${rule.realPath}\0${rule.contentHash}`);
      const block = formatStatic(rules, config);
      return block ? { systemPrompt: event.systemPrompt + block } : undefined;
    });

    pi.on("tool_result", async (event, ctx) => {
      if (event.isError || !TRACKED_TOOLS.has(event.toolName)) return undefined;
      const additions = [];
      const targets = extractToolPaths(event, ctx.cwd);
      if (event.toolName === "read" && pi.getFlag("no-nested-agents") !== true
        && event.content.some((block) => block.type === "text")) {
        const key = sessionKey(ctx);
        let injected = injectedBySession.get(key);
        if (!injected) {
          injected = new Set();
          injectedBySession.set(key, injected);
        }
        for (const target of targets) {
          additions.push(...await nestedAgentsBlocks({ rootDir: ctx.cwd, inputPath: target, injectedDirectories: injected }));
        }
      }

      const mode = ruleMode();
      if (mode !== "off" && mode !== "static") {
        for (const target of targets) {
          const discovered = loadCandidates({ cwd: ctx.cwd, targetPath: target, homeDir, staticLoad: false });
          const fresh = discovered.filter((rule) => {
            const key = `${rule.realPath}\0${rule.contentHash}`;
            if (staticInjected.has(key) || dynamicInjected.has(key)) return false;
            dynamicInjected.add(key);
            return true;
          });
          if (fresh.length > 0) {
            latestRules = fresh;
            additions.push(formatDynamic(fresh, target, ctx.cwd, config));
          }
        }
      }
      return additions.length > 0
        ? { content: [...event.content, { type: "text", text: additions.join("") }] }
        : undefined;
    });

    pi.registerCommand("rules", {
      description: "Inspect loaded pi-rules.",
      handler: async (args, ctx) => {
        const subcommand = args.trim().split(/\s+/)[0] || "status";
        if (subcommand === "paths") {
          ctx.ui.notify(latestRules.map((rule) => rule.path).join("\n") || "No rules loaded", "info");
          return;
        }
        if (subcommand === "list") {
          ctx.ui.notify(latestRules.map((rule) => `${rule.relativePath} [${rule.source}]`).join("\n") || "No rules loaded", "info");
          return;
        }
        ctx.ui.notify(`pi-rules: ${latestRules.length} rules`, "info");
      },
    });
    pi.registerCommand("reload-rules", {
      description: "Reload pi-rules for the current session.",
      handler: async (_args, ctx) => {
        reset();
        ctx.ui.notify("Rule caches cleared; rules reload on the next prompt or file tool result", "info");
      },
    });
  };
}

export const instructionContract = Object.freeze({
  projectMarkers: PROJECT_MARKERS,
  projectRuleSubdirs: PROJECT_RULE_SUBDIRS,
  projectSingleFiles: PROJECT_SINGLE_FILES,
  userRuleSubdirs: USER_RULE_SUBDIRS,
  userSingleFiles: USER_SINGLE_FILES,
});
