// Senpi-origin permission evaluation adapted to an explicit settings/approval boundary.
// MIT attribution and license: ./THIRD_PARTY_NOTICES.md

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PRESETS = new Set(["full-access", "workspace", "read-only", "ask"]);
export const DEFAULT_PERMISSION_PRESET = "full-access";
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);
const PRESET_RULES = {
  "full-access": [{ permission: "*", pattern: "*", action: "allow" }],
  workspace: [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "ask" },
  ],
  "read-only": [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
  ],
  ask: [{ permission: "*", pattern: "*", action: "ask" }],
};

export class PermissionDeniedError extends Error {
  constructor(patterns) {
    super("The user has specified a rule which prevents you from using this specific tool call.");
    this.name = "DeniedError";
    this.patterns = patterns;
  }
}

export function wildcardMatch(value, pattern) {
  if (pattern === "") return value === "";
  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let matchIndex = 0;
  while (valueIndex < value.length) {
    if (pattern[patternIndex] === "?" || pattern[patternIndex] === value[valueIndex]) {
      valueIndex += 1;
      patternIndex += 1;
    } else if (pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      matchIndex = valueIndex;
      patternIndex += 1;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      matchIndex += 1;
      valueIndex = matchIndex;
    } else return false;
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function matchesPattern(value, pattern) {
  return wildcardMatch(value, pattern) || (pattern.endsWith(" *") && wildcardMatch(value, pattern.slice(0, -2)));
}

export function evaluatePermission(permission, pattern, ...rulesets) {
  return rulesets.flat().findLast((rule) => wildcardMatch(permission, rule.permission) && matchesPattern(pattern, rule.pattern))
    ?? { action: "ask", permission, pattern: "*" };
}

export function parsePermissionFlag(value = "") {
  return value.split(",").flatMap((entry) => {
    const match = entry.trim().match(/^([^:=]+)(?::([^=]+))?=(.+)$/);
    return match ? [{ permission: match[1].trim(), pattern: match[2]?.trim() || "*", action: match[3].trim() }] : [];
  });
}

export function rulesForPreset(name) {
  if (!PRESETS.has(name)) throw new Error(`Invalid permission preset "${name}". Expected one of: full-access, workspace, read-only, ask.`);
  return PRESET_RULES[name].map((rule) => ({ ...rule }));
}

function expandHome(value) {
  if (value === "~" || value === "$HOME") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  if (value.startsWith("$HOME/") || value.startsWith("$HOME\\")) return path.join(os.homedir(), value.slice(6));
  return value;
}

function normalizePath(value) {
  let candidate = path.normalize(value);
  const suffix = [];
  for (;;) {
    try {
      const resolved = fs.realpathSync(candidate);
      return suffix.length === 0 ? resolved : path.join(resolved, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") return candidate;
      const parent = path.dirname(candidate);
      if (parent === candidate) return candidate;
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function isExternalPath(inputPath, cwd) {
  const root = normalizePath(cwd);
  const expanded = expandHome(inputPath);
  const target = normalizePath(path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded));
  return target !== root && !target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function externalRequest(paths, cwd, scope) {
  const external = paths.filter((value) => isExternalPath(value, cwd));
  if (external.length === 0) return [];
  return [{
    permission: "external_directory",
    patterns: external,
    always: external.map((value) => {
      if (scope === "directory") return value.endsWith("/") || value.endsWith("\\") ? `${value}*` : `${value}/*`;
      const parent = value.replace(/[\\/][^\\/]+$/, "/*");
      return parent === "/*" ? value : parent;
    }),
  }];
}

const COMMAND_ARITY = new Map(Object.entries({
  cat: 1, cd: 1, chmod: 1, chown: 1, cp: 1, echo: 1, env: 1, export: 1,
  grep: 1, kill: 1, killall: 1, ln: 1, ls: 1, mkdir: 1, mv: 1, ps: 1,
  pwd: 1, rm: 1, rmdir: 1, sleep: 1, source: 1, tail: 1, touch: 1, unset: 1, which: 1,
  aws: 3, az: 3, bazel: 2, brew: 2, bun: 2, "bun run": 3, "bun x": 3,
  cargo: 2, "cargo add": 3, "cargo run": 3, cdk: 2, cf: 2, cmake: 2,
  composer: 2, consul: 2, "consul kv": 3, crictl: 2, deno: 2, "deno task": 3,
  doctl: 3, docker: 2, "docker builder": 3, "docker compose": 3,
  "docker container": 3, "docker image": 3, "docker network": 3, "docker volume": 3,
  eksctl: 2, "eksctl create": 3, firebase: 2, flyctl: 2, gcloud: 3, gh: 3,
  git: 2, "git config": 3, "git remote": 3, "git stash": 3, go: 2, gradle: 2,
  helm: 2, heroku: 2, hugo: 2, ip: 2, "ip addr": 3, "ip link": 3,
  "ip netns": 3, "ip route": 3, kind: 2, "kind create": 3, kubectl: 2,
  "kubectl kustomize": 3, "kubectl rollout": 3, kustomize: 2, make: 2, mc: 2,
  "mc admin": 3, minikube: 2, mongosh: 2, mysql: 2, mvn: 2, ng: 2,
  npm: 2, "npm exec": 3, "npm init": 3, "npm run": 3, "npm view": 3,
  nvm: 2, nx: 2, openssl: 2, "openssl req": 3, "openssl x509": 3,
  pip: 2, pipenv: 2, pnpm: 2, "pnpm dlx": 3, "pnpm exec": 3, "pnpm run": 3,
  poetry: 2, podman: 2, "podman container": 3, "podman image": 3, psql: 2,
  pulumi: 2, "pulumi stack": 3, pyenv: 2, python: 2, rake: 2, rbenv: 2,
  "redis-cli": 2, rustup: 2, serverless: 2, sfdx: 3, skaffold: 2, sls: 2,
  sst: 2, swift: 2, systemctl: 2, terraform: 2, "terraform workspace": 3,
  tmux: 2, turbo: 2, ufw: 2, vault: 2, "vault auth": 3, "vault kv": 3,
  vercel: 2, volta: 2, wp: 2, yarn: 2, "yarn dlx": 3, "yarn run": 3,
}));

function commandPrefix(command) {
  const tokens = command.split(/\s+/).filter(Boolean);
  for (let length = tokens.length; length > 0; length -= 1) {
    const arity = COMMAND_ARITY.get(tokens.slice(0, length).join(" "));
    if (arity !== undefined) return tokens.slice(0, arity).join(" ");
  }
  return tokens[0] ?? "";
}

function tokenizeCommand(command) {
  const tokens = [];
  let current = "";
  let quote;
  let escaped = false;
  for (const character of command) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\") { current += character; escaped = true; continue; }
    if (quote) { if (character === quote) quote = undefined; current += character; continue; }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === " " || character === "\t") {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function externalCommandPaths(command, cwd) {
  const tokens = tokenizeCommand(command);
  const start = tokens[0] && !/[\\/~]/.test(tokens[0]) && !tokens[0].startsWith("$") ? 1 : 0;
  return tokens.slice(start)
    .map((token) => token.replace(/^(['"])(.*)\1$/, "$2"))
    .filter((token) => !token.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
    .filter((token) => token.startsWith("/") || token.startsWith("~") || token.startsWith("$HOME") || token.startsWith("./") || token.startsWith("../") || token.includes("/"))
    .filter((token) => !["|", "||", "&&", ";", "&", "$(", "${", "`"].some((operator) => token.includes(operator)))
    .filter((token) => isExternalPath(token, cwd));
}

function extractPatchedPaths(text) {
  return [...text.replace(/\r\n?/g, "\n").matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/gm)]
    .map((match) => match[1] ?? "");
}

function value(input, ...keys) {
  return keys.map((key) => input[key]).find((candidate) => typeof candidate === "string");
}

export function parsePermissionRequests(toolName, input, cwd) {
  const fallback = (permission) => [{ permission, patterns: ["*"], always: ["*"] }];
  if (toolName === "monitor" && value(input, "path")) {
    const filePath = value(input, "path");
    return [{ permission: "read", patterns: [filePath], always: [filePath] }, ...externalRequest([filePath], cwd, "file")];
  }
  if (toolName === "bash" || toolName === "bash_input" || toolName === "monitor") {
    const command = value(input, toolName === "bash" || toolName === "monitor" ? "command" : "input");
    if (!command) return fallback("bash");
    const prefix = commandPrefix(command);
    const requests = [{ permission: "bash", patterns: [prefix || command], always: prefix ? [prefix, `${prefix} *`] : ["*"] }];
    const external = externalCommandPaths(command, cwd);
    return [...requests, ...externalRequest(external, cwd, "file")];
  }
  if (EDIT_TOOLS.has(toolName)) {
    const directPath = value(input, "path", "file_path");
    const paths = directPath ? [directPath] : extractPatchedPaths(value(input, "input", "patchText") ?? "");
    if (paths.length === 0) return fallback("edit");
    return [
      ...paths.map((filePath) => ({ permission: "edit", patterns: [filePath], always: [filePath] })),
      ...externalRequest(paths, cwd, "file"),
    ];
  }
  if (toolName === "read") {
    const filePath = value(input, "path", "file_path");
    if (!filePath) return fallback("read");
    return [{ permission: "read", patterns: [filePath], always: [filePath] }, ...externalRequest([filePath], cwd, "file")];
  }
  if (toolName === "grep") {
    const searchPath = value(input, "path");
    const pattern = searchPath ?? value(input, "pattern");
    if (!pattern) return fallback("grep");
    return [{ permission: "grep", patterns: [pattern], always: ["*"] }, ...(searchPath ? externalRequest([searchPath], cwd, "directory") : [])];
  }
  if (toolName === "find" || toolName === "ls") {
    const searchPath = value(input, "path") ?? ".";
    return [{ permission: "list", patterns: [searchPath], always: [searchPath] }, ...externalRequest([searchPath], cwd, "directory")];
  }
  return fallback(toolName);
}

function disabledTools(tools, rules) {
  return new Set(tools.filter((tool) => {
    const permission = EDIT_TOOLS.has(tool) ? "edit" : tool;
    const rule = rules.findLast((candidate) => wildcardMatch(permission, candidate.permission));
    return rule?.pattern === "*" && rule.action === "deny";
  }));
}

function reasonFor(permission, patterns, source) {
  return source === "ask"
    ? `Permission required for ${permission} (${patterns.join(", ")}). Use --permission ${permission}=allow to override.`
    : "The user has specified a rule which prevents you from using this specific tool call.";
}

function requestDisplay(request) {
  const metadata = request.metadata ?? {};
  let detail;
  if (request.permission === "edit") detail = `File: ${metadata.filepath ?? metadata.path ?? "Unknown"}`;
  else if (request.permission === "read") detail = `Path: ${metadata.filePath ?? metadata.path ?? "Unknown"}`;
  else if (request.permission === "grep" || request.permission === "glob") detail = `Pattern: ${metadata.pattern ?? "Unknown"}`;
  else if (request.permission === "list") detail = `Path: ${metadata.path ?? "Unknown"}`;
  else if (request.permission === "bash") detail = `${metadata.description ? `Description: ${metadata.description}\n` : ""}Command: $ ${metadata.command ?? metadata.input ?? "Unknown"}`;
  else detail = `Tool: ${request.permission}`;
  return `${detail}\n\nPatterns:\n${request.patterns.map((pattern) => `  - ${pattern}`).join("\n")}`;
}

export async function showPermissionPrompt(ctx, request) {
  const options = ["Allow once", "Allow always", "Deny", "Deny with feedback"];
  const choice = await ctx.ui.select(`Permission required: ${request.permission}\n\n${requestDisplay(request)}`, options);
  if (choice === "Deny with feedback") {
    const message = await ctx.ui.input("Feedback", "Why are you denying this permission? (optional)");
    return { reply: "reject", ...(message ? { message } : {}) };
  }
  return { reply: choice === "Allow once" ? "once" : choice === "Allow always" ? "always" : "reject" };
}

export function createPermissionExtension(options = {}) {
  return function permissionExtension(pi) {
    let staticRules = rulesForPreset(DEFAULT_PERMISSION_PRESET);
    let approved = [];
    let pending = new Map();
    let initialApprovedCount = 0;
    let counter = 0;
    pi.registerFlag("permission", { description: "Set permission rules (format: tool=action or tool:pattern=action)", type: "string" });
    pi.registerFlag("permission-preset", { description: "Set permission preset (full-access, workspace, read-only, or ask)", type: "string" });

    pi.on("session_start", async (_event, ctx) => {
      const configured = await options.resolveSettings?.(ctx, pi) ?? {};
      const flagPreset = pi.getFlag("permission-preset");
      const preset = typeof flagPreset === "string" ? flagPreset : (configured.preset ?? DEFAULT_PERMISSION_PRESET);
      const flagRules = typeof pi.getFlag("permission") === "string" ? parsePermissionFlag(pi.getFlag("permission")) : [];
      staticRules = [
        ...rulesForPreset(DEFAULT_PERMISSION_PRESET),
        ...(configured.preset && configured.preset !== DEFAULT_PERMISSION_PRESET ? rulesForPreset(configured.preset) : []),
        ...(configured.rules ?? []),
        ...(preset !== configured.preset && preset !== DEFAULT_PERMISSION_PRESET ? rulesForPreset(preset) : []),
        ...flagRules,
      ];
      approved = [...(configured.approved ?? [])];
      initialApprovedCount = approved.length;
      pending = new Map();
      const disabled = disabledTools(pi.getAllTools().map(({ name }) => name), staticRules);
      pi.setActiveTools(pi.getActiveTools().filter((name) => !disabled.has(name)));
    });

    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName === "monitor" && typeof event.input.path === "string") {
        await options.prepareMonitorInput?.(event.input, ctx);
      }
      for (const request of parsePermissionRequests(event.toolName, event.input, ctx.cwd)) {
        const denied = [];
        let ask = false;
        for (const pattern of request.patterns) {
          const rule = evaluatePermission(request.permission, pattern, staticRules, approved);
          if (rule.action === "deny") denied.push(pattern);
          else if (rule.action === "ask") ask = true;
        }
        if (denied.length > 0) return { block: true, reason: reasonFor(request.permission, denied, "deny") };
        const id = `permission-${++counter}`;
        const info = { ...request, id, sessionID: ctx.sessionManager.getSessionId(), metadata: { toolName: event.toolName, ...event.input } };
        if (!ask) {
          pi.events.emit("permission_replied", { requestID: id, sessionID: info.sessionID, reply: "allow" });
          continue;
        }
        pi.events.emit("permission_asked", info);
        let rejectOnShutdown;
        const shutdown = new Promise((resolve) => { rejectOnShutdown = resolve; });
        pending.set(id, { reject: () => rejectOnShutdown({ reply: "reject", message: "Permission request ended because the session shut down." }) });
        let reply;
        try {
          const approval = options.requestApproval
            ? Promise.resolve(options.requestApproval(info, ctx))
            : ctx.hasUI
              ? showPermissionPrompt(ctx, info)
              : Promise.resolve({ reply: "reject", message: reasonFor(request.permission, request.patterns, "ask") });
          reply = await Promise.race([approval, shutdown]);
        } finally {
          pending.delete(id);
        }
        if (!reply || !["once", "always", "reject"].includes(reply.reply)) {
          reply = { reply: "reject", message: "Permission adapter returned an invalid reply." };
        }
        pi.events.emit("permission_replied", { requestID: id, sessionID: info.sessionID, reply: reply.reply });
        if (reply.reply === "reject") return { block: true, reason: reply.message || "The user rejected permission to use this specific tool call." };
        if (reply.reply === "always") {
          approved.push(...request.always.map((pattern) => ({ permission: request.permission, pattern, action: "allow" })));
        }
      }
      return undefined;
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      for (const entry of pending.values()) entry.reject();
      pending.clear();
      const added = approved.slice(initialApprovedCount);
      if (added.length > 0) await options.persistApproved?.(ctx, added);
    });
  };
}

export const permissionExtension = createPermissionExtension();
