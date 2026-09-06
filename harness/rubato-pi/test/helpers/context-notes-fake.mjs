// Contract fake for the public senpi extension interface. This does not replace
// the mandatory local test against the actual pinned engine.
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialWindow, INIT_ENTRY, bootstrapMessage } from "../../src/context-notes/protocol.mjs";

export const Type = new Proxy({}, { get: (_target, key) => (...args) => ({ kind: key, args }) });

export function fakeSession(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rubato-context-notes-"));
  const file = join(dir, "session.jsonl");
  let sequence = 0;
  const entries = [];
  let leaf = null;
  let revision = 0;
  const sessionId = options.sessionId ?? `session-${Math.random()}`;
  const append = (body) => {
    const entry = { ...body, id: `e${++sequence}`, parentId: leaf, timestamp: new Date().toISOString() };
    entries.push(entry); leaf = entry.id; revision++;
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return entry;
  };
  const branch = () => {
    const output = [];
    let at = leaf;
    while (at) {
      const entry = entries.find((e) => e.id === at);
      if (!entry) throw new Error("broken branch");
      output.push(entry); at = entry.parentId;
    }
    return output.reverse();
  };
  const build = () => {
    const all = branch();
    const compact = all.findLast((e) => e.type === "compaction");
    const from = compact ? all.findIndex((e) => e.id === compact.firstKeptEntryId) : 0;
    const messages = all.slice(from).filter((e) => e.type === "message").map((e) => e.message);
    if (compact) messages.unshift(bootstrapMessage(compact.summary, compact.timestamp) ?? { role: "compactionSummary", summary: compact.summary });
    return { messages };
  };
  const manager = { getSessionId: () => sessionId, getBranch: branch, getLeafId: () => leaf,
    getSessionFile: () => file, getEntries: () => entries, buildSessionContext: build };
  const notices = []; const handlers = new Map(); const tools = new Map(); const commands = new Map(); const sent = [];
  const abort = new AbortController();
  const confirms = [];
  let confirmAnswer = true;
  const ctx = { sessionManager: manager, agentDir: dir, model: { id: "test-model", provider: "test", contextWindow: 32000 },
    ui: {
      notify: (...args) => notices.push(args),
      setStatus: (...args) => notices.push(args),
      confirm: async (title, message) => {
        confirms.push({ title, message });
        return typeof confirmAnswer === "function" ? confirmAnswer(title, message) : confirmAnswer;
      },
    },
    mode: "tui", hasUI: true, cwd: dir, signal: undefined,
    isIdle: () => true, getContextUsage: () => ({ tokens: 0 }), getSystemPrompt: () => "Stable system prompt",
    getMessageRevision: () => revision, abort: () => abort.abort(),
    async applyCompaction(result, opts) {
      if (opts.expectedRevision !== revision) return { applied: false, reason: "stale" };
      append({ type: "compaction", ...result });
      return { applied: true, reason: "ok" };
    } };
  const pi = { appendEntry: (customType, data) => append({ type: "custom", customType, data }),
    sendMessage: (...args) => sent.push(args),
    registerTool: (tool) => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
  const addMessage = (role, content, other = {}) => append({ type: "message", message: { role, content, timestamp: sequence + 1, ...other } });
  const dispatch = async (event, data = {}, context = ctx) => {
    const results = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...data }, context));
    return results;
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { ctx, pi, manager, addMessage, append, branch, build, notices, sent, tools, commands, dispatch,
    abort, dir, file, entries, confirms,
    setConfirm: (value) => { confirmAnswer = value; },
    rewind: (id) => { leaf = id; revision++; },
    init: () => append({ type: "custom", customType: INIT_ENTRY, data: { window: initialWindow() } }) };
}
