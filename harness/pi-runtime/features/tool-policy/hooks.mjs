// Senpi-origin command-hook execution and Pre/PostToolUse result policy.
// MIT attribution and license: ./THIRD_PARTY_NOTICES.md

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;
export const DEFAULT_HOOK_OUTPUT_BYTES = 64 * 1024;
const SUPPORTED_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "PreCompact", "PostCompact", "Stop",
]);
const MINIMAL_ENV = ["PATH", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT"];
const TOOL_ALIASES = {
  apply_patch: ["ApplyPatch", "functions.apply_patch"],
  bash: ["Bash", "Shell", "shell", "exec_command", "functions.exec_command"],
  edit: ["Edit", "MultiEdit", "multi_edit"], find: ["Find", "Glob", "glob", "file_search"],
  grep: ["Grep", "Search", "grep_app"], ls: ["LS", "List", "list"], read: ["Read", "open", "read_file"],
  todo: ["Todo"], web_search: ["WebSearch", "web-search"], webfetch: ["WebFetch", "web_fetch", "web-fetch"],
  write: ["Write", "write_file"],
};

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitDiagnostic(pi, source, code, message) {
  pi.events.emit("hook_diagnostic", { sourcePath: source.sourcePath, code, message });
}

export function parseHookConfig(config, source = { sourcePath: "<inline>", scope: "runtime", displayOrder: 0 }) {
  const handlers = [];
  const diagnostics = [];
  if (!record(config) || !record(config.hooks)) {
    return { handlers, diagnostics: [{ code: "invalid_hooks", message: "Hook config must contain an object hooks field.", source }] };
  }
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!SUPPORTED_EVENTS.has(event)) {
      diagnostics.push({ code: "unsupported_event", message: `Hook event ${event} is not executable in this stock-Pi slice.`, source });
      continue;
    }
    if (!Array.isArray(groups)) {
      diagnostics.push({ code: "invalid_event_config", message: `${event} hook groups must be an array.`, source });
      continue;
    }
    for (const [groupIndex, group] of groups.entries()) {
      if (!record(group) || !Array.isArray(group.hooks)) {
        diagnostics.push({ code: "invalid_handler_group", message: `${event}[${groupIndex}] must contain hooks[].`, source });
        continue;
      }
      for (const [handlerIndex, candidate] of group.hooks.entries()) {
        if (!record(candidate) || candidate.type !== "command" || typeof candidate.command !== "string") {
          diagnostics.push({ code: "unsupported_handler_type", message: `${event}[${groupIndex}].hooks[${handlerIndex}] must be a command hook.`, source });
          continue;
        }
        if (candidate.async === true || "args" in candidate || ["if", "shell", "asyncRewake", "terminalSequence", "continueOnBlock"].some((key) => key in candidate)) {
          diagnostics.push({ code: "unsupported_field", message: `${event}[${groupIndex}].hooks[${handlerIndex}] uses an unsupported command shape.`, source });
          continue;
        }
        if (candidate.timeout !== undefined && (!Number.isFinite(candidate.timeout) || candidate.timeout <= 0)) {
          diagnostics.push({ code: "invalid_timeout", message: "Command hook timeout must be a finite number greater than 0.", source });
          continue;
        }
        handlers.push({
          event,
          matcher: typeof group.matcher === "string" ? group.matcher : undefined,
          groupIndex,
          handlerIndex,
          source,
          config: {
            command: candidate.command,
            commandWindows: typeof candidate.commandWindows === "string" ? candidate.commandWindows : candidate.command_windows,
            timeout: candidate.timeout,
            statusMessage: typeof candidate.statusMessage === "string" ? candidate.statusMessage : undefined,
          },
        });
      }
    }
  }
  return { handlers, diagnostics };
}

function toolMatcherInputs(toolName) {
  const lower = toolName.toLowerCase();
  const pascal = lower.split(/[-_]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("");
  return new Set([toolName, lower, pascal, ...(TOOL_ALIASES[lower] ?? [])]);
}

function matches(handler, matcherInputs) {
  const matcher = handler.matcher?.trim();
  if (!matcher || matcher === "*") return true;
  const inputs = new Set((Array.isArray(matcherInputs) ? matcherInputs : [matcherInputs])
    .flatMap((input) => [...toolMatcherInputs(input)]));
  if (matcher.split(/[|,]/).map((part) => part.trim()).some((part) => inputs.has(part))) return true;
  try {
    const expression = new RegExp(matcher);
    return [...inputs].some((input) => expression.test(input));
  } catch {
    return false;
  }
}

function redact(text) {
  return text
    .replace(/\b([A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|AUTH)[A-Z0-9_]*)=([^\s'"]+)/g, "$1=[REDACTED]")
    .replace(/\b(Authorization:\s*Bearer\s+)([^\s'"]+)/gi, "$1[REDACTED]")
    .replace(/\b(Bearer\s+)(sk-[A-Za-z0-9._-]+)/g, "$1[REDACTED]")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]");
}

function outputCapture(maxBytes) {
  const chunks = [];
  let keptBytes = 0;
  let originalBytes = 0;
  return {
    append(chunk) {
      const buffer = Buffer.from(chunk);
      originalBytes += buffer.length;
      if (keptBytes >= maxBytes) return;
      const length = Math.min(maxBytes - keptBytes, buffer.length);
      chunks.push(buffer.subarray(0, length));
      keptBytes += length;
    },
    finish() {
      const raw = Buffer.concat(chunks).toString("utf8");
      const redacted = redact(raw);
      const text = Buffer.from(redacted).subarray(0, maxBytes).toString("utf8");
      return {
        originalBytes,
        redacted: redacted !== raw,
        text,
        truncated: originalBytes > keptBytes || Buffer.byteLength(redacted) > maxBytes,
      };
    },
  };
}

async function finalizeOutput(capture, stream, options) {
  const output = capture.finish();
  let spillPath;
  let spillError;
  if (output.truncated) {
    const spillDir = options.outputPolicy?.spillDir ?? path.join(tmpdir(), "senpi-hook-output");
    try {
      await mkdir(spillDir, { recursive: true });
      spillPath = path.join(spillDir, `hook-${stream}-${process.pid}-${randomUUID()}.txt`);
      await writeFile(spillPath, output.text);
    } catch (error) {
      spillPath = undefined;
      spillError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    text: output.text,
    safety: {
      originalBytes: output.originalBytes,
      redacted: output.redacted,
      returnedBytes: Buffer.byteLength(output.text),
      spilled: spillPath !== undefined,
      truncated: output.truncated,
      ...(spillPath === undefined ? {} : { spillPath }),
      ...(spillError === undefined ? {} : { spillError }),
    },
  };
}

function hookEnvironment(handler, input, options) {
  const env = {};
  const source = options.sourceEnv ?? process.env;
  for (const key of [...MINIMAL_ENV, ...(options.envPassthrough ?? [])]) if (source[key] !== undefined) env[key] = source[key];
  if (handler.source.pluginEnv) Object.assign(env, handler.source.pluginEnv);
  env.SENPI_HOOK_SOURCE = handler.source.sourcePath;
  env.SENPI_HOOK_EVENT = input.event;
  return env;
}

function stopChild(child) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
}

export async function runCommandHook(handler, input, options = {}) {
  const command = process.platform === "win32" && handler.config.commandWindows
    ? handler.config.commandWindows
    : handler.config.command;
  const timeoutSeconds = handler.config.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS;
  if (options.signal?.aborted) return { aborted: true, command, exitCode: null, stderr: "", stdout: "", timedOut: false, timeoutSeconds };
  const maxStdout = options.outputPolicy?.maxStdoutBytes ?? DEFAULT_HOOK_OUTPUT_BYTES;
  const maxStderr = options.outputPolicy?.maxStderrBytes ?? DEFAULT_HOOK_OUTPUT_BYTES;
  const child = spawn(command, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: hookEnvironment(handler, input, options),
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = outputCapture(maxStdout);
  const stderr = outputCapture(maxStderr);
  child.stdout?.on("data", (chunk) => stdout.append(chunk));
  child.stderr?.on("data", (chunk) => stderr.append(chunk));
  child.stdin?.end(JSON.stringify(input));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stopChild(child); }, timeoutSeconds * 1000);
  const abort = () => stopChild(child);
  options.signal?.addEventListener("abort", abort, { once: true });
  let exitCode = null;
  let spawnError;
  try {
    exitCode = await new Promise((resolve) => {
      child.once("error", (error) => { spawnError = error; resolve(1); });
      child.once("close", (code) => resolve(code));
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
  const stdoutResult = await finalizeOutput(stdout, "stdout", options);
  const stderrResult = await finalizeOutput(stderr, "stderr", options);
  return {
    aborted: options.signal?.aborted === true,
    command,
    exitCode: timedOut || options.signal?.aborted ? null : exitCode,
    outputSafety: { stdout: stdoutResult.safety, stderr: stderrResult.safety },
    stderr: spawnError ? String(spawnError.message) : stderrResult.text,
    stdout: stdoutResult.text,
    timedOut,
    timeoutSeconds,
  };
}

export function parseHookOutput(event, run) {
  if (run.exitCode === 2) return { decision: "block", reason: run.stderr.trim() || undefined };
  if (!run.stdout.trim()) return {};
  let value;
  try { value = JSON.parse(run.stdout); } catch { return {}; }
  if (!record(value)) return {};
  if (value.hookSpecificOutput !== undefined && !record(value.hookSpecificOutput)) return {};
  if (record(value.hookSpecificOutput) && value.hookSpecificOutput.hookEventName !== undefined
    && value.hookSpecificOutput.hookEventName !== event) return {};
  const specific = record(value.hookSpecificOutput) ? value.hookSpecificOutput : {};
  if (event === "PreToolUse") {
    let decision = specific.permissionDecision ?? value.decision;
    if (decision === "deny") decision = "block";
    if (!["allow", "approve", "ask", "block"].includes(decision)) decision = undefined;
    return {
      decision,
      reason: specific.permissionDecisionReason ?? value.reason,
      additionalContext: specific.additionalContext ?? value.additionalContext,
      ...(specific.permissionDecision === "allow" && record(specific.updatedInput) ? { updatedInput: specific.updatedInput } : {}),
    };
  }
  if (event === "UserPromptSubmit") return {
    decision: value.decision === "block" || value.decision === "deny" ? "block" : undefined,
    reason: value.reason,
    additionalContext: specific.additionalContext ?? value.additionalContext,
    systemMessage: value.systemMessage,
  };
  if (event === "Stop") return {
    decision: value.continue === false || value.decision === "block" ? "block" : undefined,
    reason: value.reason,
    stopReason: value.stopReason,
    additionalContext: specific.additionalContext ?? value.additionalContext,
    systemMessage: value.systemMessage,
  };
  if (event !== "PostToolUse") return {
    decision: value.decision === "block" || value.decision === "deny" ? "block" : undefined,
    reason: specific.permissionDecisionReason ?? value.reason,
    additionalContext: specific.additionalContext ?? value.additionalContext,
    customInstructions: specific.customInstructions ?? value.customInstructions,
  };
  return {
    decision: value.decision === "block" ? "block" : undefined,
    reason: value.reason,
    additionalContext: specific.additionalContext ?? value.additionalContext,
    updatedToolOutput: specific.updatedToolOutput ?? value.updatedToolOutput,
  };
}

function normalizeOutput(value) {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (Array.isArray(value)) return { content: value };
  if (!record(value)) return undefined;
  if (typeof value.content === "string") return { content: [{ type: "text", text: value.content }], details: value.details };
  if (Array.isArray(value.content)) return { content: value.content, details: value.details };
  return undefined;
}

function replaceInput(target, replacement) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

async function defaultSources(ctx, options) {
  const candidates = [
    ...(options.agentDir ? [{ path: path.join(options.agentDir, "hooks.json"), scope: "global" }] : []),
    { path: path.join(ctx.cwd, ".senpi", "hooks.json"), scope: "project" },
  ];
  const sources = [];
  for (const [displayOrder, candidate] of candidates.entries()) {
    try {
      sources.push({ ...candidate, sourcePath: candidate.path, displayOrder, config: JSON.parse(await readFile(candidate.path, "utf8")) });
    } catch (error) {
      if (error?.code !== "ENOENT") sources.push({ ...candidate, sourcePath: candidate.path, displayOrder, loadError: error });
    }
  }
  return sources;
}

export function createHooksExtension(options = {}) {
  return function hooksExtension(pi) {
    const preContexts = new Map();
    const handlers = async (ctx) => {
      const sources = await (options.resolveSources?.(ctx) ?? defaultSources(ctx, options));
      const result = [];
      for (const [displayOrder, sourceInput] of sources.entries()) {
        const source = {
          scope: sourceInput.scope ?? "runtime",
          sourcePath: sourceInput.sourcePath ?? "<inline>",
          displayOrder: sourceInput.displayOrder ?? displayOrder,
          discoveredAt: sourceInput.discoveredAt,
          pluginEnv: sourceInput.pluginEnv,
          pluginRoot: sourceInput.pluginRoot,
        };
        if (sourceInput.loadError) {
          emitDiagnostic(pi, source, "invalid_root", String(sourceInput.loadError));
          continue;
        }
        const parsed = parseHookConfig(sourceInput.config, source);
        for (const diagnostic of parsed.diagnostics) emitDiagnostic(pi, source, diagnostic.code, diagnostic.message);
        for (const handler of parsed.handlers) {
          const trusted = sourceInput.trusted === true || await options.isTrusted?.(handler, ctx) === true;
          if (trusted) result.push(handler);
          else emitDiagnostic(pi, source, "untrusted", `Hook command is not trusted: ${handler.config.command}`);
        }
      }
      return result.sort((left, right) => left.source.displayOrder - right.source.displayOrder || left.groupIndex - right.groupIndex || left.handlerIndex - right.handlerIndex);
    };

    const dispatch = async (eventName, matcherInputs, input, ctx, signal = ctx.signal) => {
      const selected = (await handlers(ctx)).filter((handler) => handler.event === eventName
        && !(eventName === "SessionStart" && input.reason === "startup" && handler.source.discoveredAt === "runtime")
        && matches(handler, matcherInputs));
      const completed = await Promise.all(selected.map(async (handler) => {
        const run = await (options.runCommand ?? runCommandHook)(handler, input, {
          cwd: ctx.cwd, signal, envPassthrough: options.envPassthrough,
          outputPolicy: options.outputPolicy, sourceEnv: options.sourceEnv,
        });
        if (run.timedOut || run.aborted || (run.exitCode !== 0 && run.exitCode !== 2)) {
          emitDiagnostic(pi, handler.source, "command_failed", run.timedOut
            ? `Hook command timed out after ${run.timeoutSeconds}s.`
            : run.aborted ? "Hook command was aborted." : `Hook command failed with exit code ${run.exitCode}.`);
        }
        return { handler, run, output: parseHookOutput(eventName, run) };
      }));
      return completed;
    };

    const transcript = (ctx) => ctx.sessionManager.getSessionFile?.();
    const lifecycleInput = (eventName, ctx, values = {}) => ({
      cwd: ctx.cwd,
      event: eventName,
      hook_event_name: eventName,
      session_id: ctx.sessionManager.getSessionId(),
      ...(transcript(ctx) === undefined ? {} : { transcript_path: transcript(ctx) }),
      ...values,
    });
    const recordLifecycle = (eventName, completed, extra = {}) => {
      const contexts = completed.flatMap(({ output }) => typeof output.additionalContext === "string" ? [output.additionalContext] : []);
      const reason = completed.find(({ output }) => output.decision === "block")?.output.reason;
      if (contexts.length === 0 && reason === undefined) return;
      pi.sendMessage({
        customType: "senpi.hook",
        content: contexts.join("\n\n") || reason,
        display: false,
        details: { event: eventName, ...extra },
      }, { triggerTurn: false });
    };
    const promptContexts = [];
    let compactCounter = 0;
    let pendingCompact;
    let stopReentries = 0;

    pi.on("session_start", async (event, ctx) => {
      const input = lifecycleInput("SessionStart", ctx, { reason: event.reason, sessionId: ctx.sessionManager.getSessionId() });
      const completed = await dispatch("SessionStart", ["SessionStart", event.reason], input, ctx);
      recordLifecycle("SessionStart", completed);
    });

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension") return undefined;
      stopReentries = 0;
      promptContexts.splice(0);
      const input = lifecycleInput("UserPromptSubmit", ctx, {
        permission_mode: options.resolvePermissionMode?.(ctx) ?? "default",
        prompt: event.text,
      });
      const completed = await dispatch("UserPromptSubmit", ["UserPromptSubmit"], input, ctx);
      const blocker = completed.find(({ output }) => output.decision === "block");
      if (blocker) {
        const reason = blocker.run.exitCode === 2 ? "UserPromptSubmit hook blocked the prompt." : (blocker.output.reason ?? "UserPromptSubmit hook blocked the prompt.");
        ctx.ui.notify(reason, "warning");
        pi.sendMessage({ customType: "senpi.hook", content: reason, display: false,
          details: { decision: "block", event: "UserPromptSubmit", sourcePath: blocker.handler.source.sourcePath } }, { triggerTurn: false });
        return { action: "handled" };
      }
      if (ctx.isIdle()) {
        const contexts = completed.flatMap(({ output }) => typeof output.additionalContext === "string" ? [output.additionalContext] : []);
        const systemMessages = completed.flatMap(({ output }) => typeof output.systemMessage === "string" ? [output.systemMessage] : []);
        if (contexts.length > 0 || systemMessages.length > 0) promptContexts.push({ contexts, systemMessages });
      }
      return { action: "continue" };
    });

    pi.on("before_agent_start", (event) => {
      const pending = promptContexts.shift();
      if (!pending) return undefined;
      return {
        ...(pending.contexts.length === 0 ? {} : { message: {
          customType: "senpi.hook", content: pending.contexts.join("\n\n"), display: false,
          details: { event: "UserPromptSubmit" },
        } }),
        ...(pending.systemMessages.length === 0 ? {} : { systemPrompt: `${event.systemPrompt}\n\n${pending.systemMessages.join("\n\n")}` }),
      };
    });

    pi.on("tool_call", async (event, ctx) => {
      preContexts.delete(event.toolCallId);
      const input = {
        event: "PreToolUse", toolName: event.toolName, toolInput: event.input, cwd: ctx.cwd,
        session_id: ctx.sessionManager.getSessionId(), hook_event_name: "PreToolUse",
        tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId,
      };
      const completed = await dispatch("PreToolUse", event.toolName, input, ctx);
      const blocker = completed.find(({ output }) => output.decision === "block");
      if (blocker) return { block: true, reason: blocker.run.exitCode === 2 ? "PreToolUse hook blocked the tool call." : (blocker.output.reason ?? "PreToolUse hook blocked the tool call.") };
      const ask = completed.find(({ output }) => output.decision === "ask");
      if (ask) return { block: true, reason: ask.output.reason ?? "Hook requested manual approval." };
      const allowed = completed.filter(({ output }) => output.decision === "allow" || output.decision === "approve").at(-1);
      if (record(allowed?.output.updatedInput)) replaceInput(event.input, allowed.output.updatedInput);
      const contexts = completed.flatMap(({ output }) => typeof output.additionalContext === "string" ? [output.additionalContext] : []);
      if (contexts.length > 0) preContexts.set(event.toolCallId, contexts);
      return undefined;
    });

    pi.on("tool_result", async (event, ctx) => {
      const previous = preContexts.get(event.toolCallId) ?? [];
      preContexts.delete(event.toolCallId);
      const input = {
        event: "PostToolUse", toolName: event.toolName, toolInput: event.input,
        toolOutput: { content: event.content, details: event.details, is_error: event.isError }, cwd: ctx.cwd,
        session_id: ctx.sessionManager.getSessionId(), hook_event_name: "PostToolUse",
        tool_name: event.toolName, tool_input: event.input,
        tool_response: { content: event.content, details: event.details, is_error: event.isError }, tool_use_id: event.toolCallId,
      };
      const completed = await dispatch("PostToolUse", event.toolName, input, ctx);
      const blocker = completed.find(({ output }) => output.decision === "block");
      const contexts = [...completed.flatMap(({ output }) => typeof output.additionalContext === "string" ? [output.additionalContext] : []), ...previous];
      if (blocker) return {
        content: [{ type: "text", text: blocker.run.exitCode === 2 ? "PostToolUse hook flagged the tool result." : (blocker.output.reason ?? "PostToolUse hook flagged the tool result.") }, ...contexts.map((text) => ({ type: "text", text }))],
        details: event.details,
        isError: true,
      };
      let content = [...event.content];
      let details = event.details;
      let changed = contexts.length > 0;
      for (const { output } of completed) {
        const replacement = normalizeOutput(output.updatedToolOutput);
        if (replacement) { content = replacement.content; details = replacement.details; changed = true; }
      }
      content.push(...contexts.map((text) => ({ type: "text", text })));
      return changed ? { content, ...(details === undefined ? {} : { details }) } : undefined;
    });

    pi.on("session_before_compact", async (event, ctx) => {
      const requestId = `compact-${++compactCounter}`;
      pendingCompact = requestId;
      const input = lifecycleInput("PreCompact", ctx, {
        reason: event.reason, request_id: requestId, will_retry: event.willRetry,
        ...(event.customInstructions === undefined ? {} : { custom_instructions: event.customInstructions }),
      });
      const completed = await dispatch("PreCompact", ["PreCompact", event.reason], input, ctx, event.signal);
      const blocker = completed.find(({ output }) => output.decision === "block");
      recordLifecycle("PreCompact", completed, { compactionRequestId: requestId });
      return blocker ? { cancel: true } : undefined;
    });

    pi.on("session_compact", async (event, ctx) => {
      const requestId = pendingCompact ?? `compact-${++compactCounter}`;
      pendingCompact = undefined;
      const input = lifecycleInput("PostCompact", ctx, {
        accepted: true, reason: event.reason, request_id: requestId, will_retry: event.willRetry,
      });
      const completed = await dispatch("PostCompact", ["PostCompact", event.reason], input, ctx);
      recordLifecycle("PostCompact", completed, { compactionRequestId: requestId });
    });

    pi.on("session_compact_failed", () => { pendingCompact = undefined; });

    pi.on("agent_end", async (event, ctx) => {
      const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
      const input = lifecycleInput("Stop", ctx, {
        ...(typeof lastAssistant?.stopReason === "string" ? { stopReason: lastAssistant.stopReason } : {}),
      });
      const completed = await dispatch("Stop", ["Stop"], input, ctx);
      const blocker = completed.find(({ output }) => output.decision === "block");
      if (!blocker) return;
      if (stopReentries >= 8) {
        emitDiagnostic(pi, blocker.handler.source, "stop_reentry_limit", "Stop hook reentry limit reached.");
        return;
      }
      const followUp = blocker.output.reason ?? blocker.output.stopReason ?? blocker.output.additionalContext;
      if (typeof followUp !== "string" || followUp.trim() === "") {
        emitDiagnostic(pi, blocker.handler.source, "missing_stop_followup", "Stop hook blocked without follow-up context.");
        return;
      }
      stopReentries += 1;
      if (options.sendFollowUp) await options.sendFollowUp(followUp, ctx);
      else pi.sendUserMessage(followUp, { deliverAs: "followUp" });
    });

    pi.on("session_shutdown", () => {
      preContexts.clear();
      promptContexts.splice(0);
      pendingCompact = undefined;
      stopReentries = 0;
    });
  };
}

export const hooksExtension = createHooksExtension();
