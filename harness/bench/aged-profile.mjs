#!/usr/bin/env node
// A synthetic long-used Rubato profile, for measuring what grows with use (harness/bench/README.md).
//
// The engine's slow paths so far all redid work over the whole history on every event, and a fresh
// profile or a small test fixture hides them. This writes a profile shaped after the person's own
// after three months of daily use (measured 2026-11-21, ~/.rubato-pi/agent):
//
//   2,144 conversation files, 5.0 GB; sizes p10 8 KB, p50 0.67 MB, p90 5.2 MB, p99 29 MB; a quarter of
//   them in Pi's older per-folder directories; 1,500+ `-artifacts` folders next to them
//   the largest conversations 143, 113 and 100 MB; the companion's (Segno) 100 MB, 24,000 entries,
//   19,500 messages, 8 context-window changes, 813 note entries, 47 MB of tool results (200 images)
//   626 context-notes archives (one per conversation that ran in the last 14 days)
//   1,764 speed-index sample files, 181 MB; the engine's session index
//
// The output is the same for the same options (`--now` included); every size is an option. The
// conversations, notes archives and session index are written by, or checked against, the engine's
// own code, so their format is the installed one.
//
//   node harness/bench/aged-profile.mjs --out /tmp/rubato-aged [--size-scale 0.25] [--sessions 2140] ...
//
// Layout under --out:
//   agent/   the profile (pass it to the engine as --agent-dir)
//   home/    a HOME for the engine: the companion's home lives here, never the person's
//   work/    the folders the conversations ran in (a conversation opens only where its folder exists)
//   manifest.json  options, counts and the conversations a bench opens by name
import { parseArgs } from 'node:util';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = Object.freeze({
  sessions: 2140, artifacts: 1500, large: '143,113', companionMb: 100, samples: 1760, sizeScale: 1, seed: 1,
  notesDays: 14, legacyShare: 0.26, projects: 12, modelPort: 47811, index: true,
});

/** Conversation sizes (bytes) by quantile, measured on the real profile (largest ones apart). */
const SIZE_QUANTILES = [[0, 1_000], [0.1, 7_939], [0.5, 671_660], [0.75, 1_975_415], [0.9, 5_150_790],
  [0.95, 8_137_428], [0.99, 29_073_586], [1, 60_000_000]];

// ---- determinism ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hex = (rng, n) => { let s = ''; while (s.length < n) s += Math.floor(rng() * 0x100000000).toString(16).padStart(8, '0'); return s.slice(0, n); };
/** A UUIDv7 for `ms`, as Pi and the notes protocol validate them. */
const uuid7 = (rng, ms) => {
  const t = Math.floor(ms).toString(16).padStart(12, '0');
  const r = hex(rng, 20);
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${r.slice(0, 3)}-${'89ab'[Math.floor(rng() * 4)]}${r.slice(3, 6)}-${r.slice(6, 18)}`;
};
const between = (rng, lo, hi) => lo + rng() * (hi - lo);
const logBetween = (rng, lo, hi) => Math.exp(between(rng, Math.log(lo), Math.log(hi)));
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
function sizeAt(q) {
  for (let i = 1; i < SIZE_QUANTILES.length; i += 1) {
    const [q1, s1] = SIZE_QUANTILES[i];
    if (q <= q1) {
      const [q0, s0] = SIZE_QUANTILES[i - 1];
      return Math.exp(Math.log(s0) + (Math.log(s1) - Math.log(s0)) * ((q - q0) / (q1 - q0)));
    }
  }
  return SIZE_QUANTILES.at(-1)[1];
}

// ---- content ----
const WORDS = ('오빠 지금 세션 엔진 대화 기록 메모 확인 했어 그래서 다음 파일 경로 테스트 빌드 실패 원인 고쳤어 좋아 '
  + 'the engine thread session file test build commit branch result change value error output path read write '
  + 'function return const await async import export class 측정 시간 결과 정리 이어서 남은 것 먼저 봐줘 응 맞아').split(' ');
function corpus(rng, bytes) {
  const parts = [];
  let size = 0;
  while (size < bytes) {
    const word = rng() < 0.02 ? '\n' : pick(rng, WORDS);
    parts.push(word); size += Buffer.byteLength(word) + 1;
  }
  return parts.join(' ');
}

class Content {
  constructor(rng) {
    this.rng = rng;
    this.text = corpus(rng, 2_000_000);
    const bytes = Buffer.alloc(1_200_000);
    for (let i = 0; i < bytes.length; i += 4) bytes.writeUInt32LE(Math.floor(rng() * 0x100000000), i);
    this.base64 = bytes.toString('base64');
  }
  /** About `chars` characters of text. */
  words(chars) {
    const n = Math.max(1, Math.min(Math.round(chars), this.text.length - 1));
    const at = Math.floor(this.rng() * (this.text.length - n));
    return this.text.slice(at, at + n);
  }
  image(chars) {
    const n = Math.min(Math.round(chars / 4) * 4, this.base64.length);
    const at = Math.floor(this.rng() * ((this.base64.length - n) / 4)) * 4;
    return this.base64.slice(at, at + n);
  }
}

// ---- one conversation ----
const NOTES_SOURCE = 'rubato-history-notes-v1';
const INIT_ENTRY = 'rubato.context-window.init.v1';
const NOTE_ENTRY = 'rubato.context-note.v1';
const MODE_ENTRY = 'rubato.context-mode.v1';
const COMPANION_ENTRY = 'rubato.companion';
const TOOLS = ['bash', 'read', 'edit', 'write', 'grep', 'eval'];
const NOTE_PATHS = ['now.md', 'now.md', 'now.md', 'todo.md', 'people/오빠.md', 'projects/rubato.md'];

/**
 * Writes one conversation of about `bytes` to `file`, entry by entry. Returns its metadata and, when
 * `keep`, the entries (the notes archive is built from them).
 */
export function writeConversation({ file, id, cwd, bytes, createdAt, endedAt, rng, content, title, companion = false,
  notes = false, windows = 0, keep = false, model = { provider: 'bench', id: 'scripted' } }) {
  const fd = openSync(file, 'w');
  const kept = keep ? [] : undefined;
  let buffer = [];
  let buffered = 0;
  let written = 0;
  let counter = 0;
  const salt = Math.floor(rng() * 0x100000000) >>> 0;
  // Entry ids: 8 hex chars, unique in the file (an odd multiplier is a bijection on 32 bits).
  const nextId = () => (((Math.imul(++counter, 2654435761) ^ salt) >>> 0).toString(16).padStart(8, '0'));
  const flush = () => { if (buffered) { writeSync(fd, buffer.join('')); buffer = []; buffered = 0; } };
  const put = (entry) => {
    const line = `${JSON.stringify(entry)}\n`;
    buffer.push(line); buffered += line.length; written += Buffer.byteLength(line);
    if (buffered > 4_000_000) flush();
    if (kept && entry.type !== 'session') kept.push(entry);
  };
  // Timestamps run from createdAt to endedAt in step with the bytes written.
  const clock = () => Math.min(endedAt, createdAt + (endedAt - createdAt) * Math.min(1, written / bytes));
  const iso = (ms) => new Date(ms).toISOString();
  let parentId = null;
  const entry = (fields) => {
    const ms = clock();
    const value = { ...fields, id: nextId(), parentId, timestamp: iso(ms) };
    put(value); parentId = value.id;
    return value;
  };
  let messages = 0;
  let lastUserId = null;
  const message = (body) => { messages += 1; const ms = clock(); return entry({ type: 'message', message: { ...body, timestamp: Math.round(ms) } }); };

  put({ type: 'session', version: 3, id, timestamp: iso(createdAt), cwd });
  if (companion) entry({ type: 'custom', customType: COMPANION_ENTRY, data: { since: iso(createdAt) } });
  if (title) entry({ type: 'session_info', name: title });
  if (companion) entry({ type: 'custom', customType: 'rubato-pi.session-title', data: { locked: true } });
  entry({ type: 'model_change', provider: model.provider, modelId: model.id });
  entry({ type: 'thinking_level_change', thinkingLevel: 'high' });
  let window;
  if (notes) {
    const first = uuid7(rng, createdAt);
    window = { firstWindowId: first, previousWindowId: null, windowId: first, number: 0 };
    entry({ type: 'custom', customType: INIT_ENTRY, data: { window, hint: 'No notes yet.' } });
    entry({ type: 'custom', customType: MODE_ENTRY, data: { mode: 'history-notes' } });
  }
  if (companion) entry({ type: 'custom', customType: 'rubato.role-prompt', data: { value: content.words(40_000) } });
  // Window changes (notes) or summaries (older conversations) fall at even shares of the size.
  const changes = notes ? windows : Math.floor(bytes / 12_000_000);
  let nextChange = changes ? bytes / (changes + 1) : Infinity;
  let changed = 0;
  let lastNoteId = null;
  const usage = () => ({ input: 2, output: Math.floor(between(rng, 50, 900)), cacheRead: Math.floor(between(rng, 0, 200_000)),
    cacheWrite: Math.floor(between(rng, 0, 40_000)), totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  // Each reply also carries its timing and speed-index records (~1 KB measured).
  const assistant = (parts, stopReason) => message({ role: 'assistant', content: parts, api: 'openai-completions',
    provider: model.provider, model: model.id, usage: usage(), stopReason, responseId: `msg_${hex(rng, 24)}`,
    timing: { sentAt: Math.round(clock()), ttftMs: between(rng, 500, 6000), waitMs: between(rng, 500, 6000), thinkMs: between(rng, 1, 50), modelDurationMs: between(rng, 800, 30_000) },
    rubatoSpeedIndex: { version: 1, metricVersion: 1, status: 'unavailable', score: null }, thinkingLevel: 'high' });

  while (written < bytes) {
    const user = message({ role: 'user', content: [{ type: 'text', text: content.words(between(rng, 20, 300)) }] });
    lastUserId = user.id;
    const rounds = rng() < 0.15 ? 0 : 1 + Math.floor(rng() * 19);
    for (let round = 0; round < rounds && written < bytes; round += 1) {
      const parts = [];
      if (rng() < 0.33) parts.push({ type: 'thinking', thinking: content.words(between(rng, 200, 2000)), thinkingSignature: content.image(1000) });
      if (rng() < 0.3) parts.push({ type: 'text', text: content.words(between(rng, 40, 600)) });
      const call = { type: 'toolCall', id: `toolu_${hex(rng, 24)}`, name: pick(rng, TOOLS), arguments: { command: content.words(between(rng, 60, 700)) } };
      parts.push(call);
      assistant(parts, 'toolUse');
      const roll = rng();
      // Measured: tool result text averages 650 bytes; 2.4% of results carry an image of ~180 KB.
      const textSize = roll < 0.8 ? logBetween(rng, 50, 600) : roll < 0.99 ? logBetween(rng, 600, 5000) : logBetween(rng, 5000, 80_000);
      const result = [{ type: 'text', text: content.words(textSize) }];
      if (rng() < 0.025) result.push({ type: 'image', data: content.image(logBetween(rng, 60_000, 500_000)), mimeType: 'image/png' });
      const tool = message({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: result, details: { status: 'completed' }, isError: rng() < 0.03 });
      if (rng() < 0.088) entry({ type: 'context_edit', targetId: tool.id, replacement: null });
    }
    const final = [];
    if (rng() < 0.5) final.push({ type: 'thinking', thinking: content.words(between(rng, 100, 1500)), thinkingSignature: content.image(800) });
    final.push({ type: 'text', text: content.words(between(rng, 60, 1800)) });
    assistant(final, 'stop');
    if (notes && rng() < 0.85) {
      const note = entry({ type: 'custom', customType: NOTE_ENTRY, data: { path: pick(rng, NOTE_PATHS), text: content.words(logBetween(rng, 1500, 30_000)),
        windowId: window.windowId, throughUserId: null, operationId: `${window.windowId}:${parentId}:toolu_${hex(rng, 24)}`,
        operationFingerprint: hex(rng, 64), append: false, throughEntryId: parentId, savedAtTokens: Math.floor(between(rng, 20_000, 400_000)) } });
      lastNoteId = note.id;
    }
    // The companion's room sends about three session messages a turn (wakes, relays), ~2 KB each.
    if (companion) for (let n = Math.floor(rng() * 7); n > 0; n -= 1) entry({ type: 'custom_message', customType: 'rubato-session-message', content: content.words(between(rng, 400, 3600)), display: true });
    if (rng() < 0.1) entry({ type: 'usage', kind: 'cache_warm', provider: model.provider, model: model.id, usage: usage() });
    if (written >= nextChange && changed < changes) {
      changed += 1;
      nextChange += bytes / (changes + 1);
      if (notes) {
        const next = { firstWindowId: window.firstWindowId, previousWindowId: window.windowId, windowId: uuid7(rng, clock()), number: window.number + 1 };
        const summary = `<rubato_context_window_v1>\n${JSON.stringify({ ...next, hint: 'Notes: now.md' })}\n</rubato_context_window_v1>`;
        entry({ type: 'compaction', summary, firstKeptEntryId: parentId, tokensBefore: Math.floor(between(rng, 300_000, 800_000)),
          details: { source: NOTES_SOURCE, window: next, checkpointEntryId: lastNoteId, preparedLeafId: parentId, reason: 'tool' }, fromHook: true,
          systemMessage: { role: 'system', content: '', sections: { preamble: content.words(60_000) } } });
        window = next;
      } else {
        entry({ type: 'compaction', summary: content.words(between(rng, 6000, 20_000)), firstKeptEntryId: lastUserId ?? parentId,
          tokensBefore: Math.floor(between(rng, 150_000, 200_000)) });
      }
    }
  }
  flush();
  closeSync(fd);
  return { id, file, bytes: written, messages, entries: counter, windows: notes ? window.number : 0, kept };
}

// ---- the profile ----
const encodeCwd = (cwd) => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
const fileStamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

function speedSample(rng, at, startedAt) {
  return { schemaVersion: 1, epoch: 'v1', at: new Date(at).toISOString(), provider: 'bench', model: 'scripted', effort: 'high',
    effortSource: 'thinkingLevelMap', reasoning: true, streamKind: 'main', clientDurationMs: between(rng, 800, 20_000),
    networkStatus: 'healthy', networkSource: 'probe', networkRttMs: between(rng, 20, 200), newInputTokens: Math.floor(between(rng, 100, 30_000)),
    cacheReadTokens: Math.floor(between(rng, 0, 200_000)), cacheWriteTokens: 0, outputTokens: Math.floor(between(rng, 20, 2000)),
    reasoningTokens: 0, fullInputTokens: 0, cacheHitRate: rng(), terminalStatus: pick(rng, ['toolUse', 'stop']),
    processId: `${startedAt}-0-0`, captureVersion: 1, requestKind: 'user', streamTerminalObserved: true,
    streamEventCount: Math.floor(between(rng, 5, 400)), maxContentGapMs: between(rng, 10, 5000), textDeltaCount: Math.floor(between(rng, 0, 200)),
    textMilestones: [[64, 65, between(rng, 100, 5000)]], tierCaptureVersion: 1, requestedServiceTier: 'unspecified', servedServiceTier: 'unknown' };
}

/** Builds the profile under `out`. Returns the manifest. */
export async function generateAgedProfile(options = {}) {
  const o = { ...DEFAULTS, ...options };
  if (!path.isAbsolute(o.out ?? '')) throw new TypeError('--out must be an absolute path');
  const now = Number.isFinite(o.now) ? o.now : Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const log = o.log ?? ((line) => console.error(line));
  if (existsSync(o.out) && readdirSync(o.out).length) {
    if (!o.force) throw new Error(`${o.out} is not empty; pass --force to replace it`);
    if (!existsSync(path.join(o.out, 'manifest.json'))) throw new Error(`${o.out} was not written by this generator; refusing to delete it`);
    rmSync(o.out, { recursive: true, force: true });
  }
  const agentDir = path.join(o.out, 'agent');
  const home = path.join(o.out, 'home');
  const work = path.join(o.out, 'work');
  const sessionsDir = path.join(agentDir, 'sessions');
  const companionHome = path.join(home, '.rubato', 'companion');
  for (const dir of [sessionsDir, companionHome, path.join(agentDir, 'speed-index', 'samples'), path.join(agentDir, 'context-notes')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rng = mulberry32(o.seed);
  const content = new Content(mulberry32(o.seed ^ 0x5eed));
  const projects = Array.from({ length: o.projects }, (_, i) => path.join(work, `project-${String(i).padStart(2, '0')}`));
  for (const dir of projects) { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n\n${content.words(4000)}\n`); }
  writeFileSync(path.join(companionHome, 'MEMORY.md'), `# memory\n\n${content.words(8000)}\n`);
  writeFileSync(path.join(companionHome, 'SOUL.md'), `# soul\n\n${content.words(6000)}\n`);
  // The scripted model (harness/bench/scripted-model.mjs) is the profile's only provider: a bench
  // never reaches a real one.
  writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { bench: { name: 'Bench (scripted)', api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${o.modelPort}/v1`, apiKey: 'bench', models: [{ id: 'scripted', name: 'Scripted', reasoning: false,
      input: ['text', 'image'], contextWindow: 1_000_000, maxTokens: 32_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }, null, 2));
  writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'bench', defaultModel: 'scripted', defaultThinkingLevel: 'off',
    lastChangelogVersion: '999.0.0' }, null, 2));

  // Conversations: ordinary ones by the measured size curve, the large ones and the companion's.
  const scale = o.sizeScale;
  const large = String(o.large || '').split(',').filter(Boolean).map((mb) => Number(mb) * 1e6 * scale);
  const plan = [];
  const span = 80 * 86_400_000;
  for (let i = 0; i < o.sessions; i += 1) {
    const createdAt = now - span + Math.floor(rng() * (span - 600_000));
    plan.push({ kind: 'ordinary', bytes: Math.max(600, sizeAt(rng()) * scale), createdAt });
  }
  // The large ones replace ordinary ones, so the count stays --sessions; they ran in the last ten days.
  large.forEach((bytes, i) => Object.assign(plan[i], { kind: 'large', bytes, createdAt: now - (10 - i * 3) * 86_400_000 }));
  if (o.companionMb > 0) Object.assign(plan[large.length], { kind: 'companion', bytes: o.companionMb * 1e6 * scale, createdAt: now - 20 * 86_400_000 });
  plan.sort((a, b) => a.createdAt - b.createdAt);
  const manifest = { generator: 'harness/bench/aged-profile.mjs', options: { ...o, log: undefined, now }, agentDir, home, work,
    sessionsDir, conversations: { large: [], companion: undefined, small: undefined, recent: [] }, totals: {} };
  const artifactShare = Math.min(1, o.artifacts / Math.max(1, o.sessions));
  let totalBytes = 0;
  let archives = 0;
  const notesCutoff = now - o.notesDays * 86_400_000;
  const { ContextNotesStore, databasePath } = await import('../rubato-pi/src/context-notes/store.mjs');
  for (const [index, item] of plan.entries()) {
    const companion = item.kind === 'companion';
    // Duration grows with size (2 ms a byte: 100 MB ran two days); the companion's runs until now.
    const endedAt = companion ? now - 300_000 : Math.min(now - 120_000, item.createdAt + Math.max(60_000, item.bytes * 2));
    const id = uuid7(rng, item.createdAt);
    const cwd = companion ? companionHome : pick(rng, projects);
    const legacy = !companion && item.kind !== 'large' && rng() < o.legacyShare;
    const dir = legacy ? path.join(sessionsDir, encodeCwd(cwd)) : sessionsDir;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${fileStamp(item.createdAt)}_${id}.jsonl`);
    const notes = companion || endedAt >= notesCutoff;
    const title = companion ? 'Segno' : item.kind === 'large' ? `Large ${Math.round(item.bytes / 1e6)} MB` : rng() < 0.6 ? content.words(between(rng, 10, 50)).replace(/\n/g, ' ') : undefined;
    const written = writeConversation({ file, id, cwd, bytes: item.bytes, createdAt: item.createdAt, endedAt, rng, content, title, companion,
      notes, windows: notes ? Math.min(8, Math.floor(item.bytes / (12e6 * scale))) : 0, keep: notes });
    totalBytes += written.bytes;
    if (notes) {
      const store = new ContextNotesStore(databasePath(agentDir, id));
      try { store.sync(written.kept); } finally { store.close(); }
      archives += 1;
    }
    if (rng() < artifactShare) {
      const folder = path.join(file.replace(/\.jsonl$/, '-artifacts'), 'tool-output');
      mkdirSync(folder, { recursive: true });
      for (let n = Math.floor(rng() * 3); n > 0; n -= 1) writeFileSync(path.join(folder, `${hex(rng, 12)}.txt`), content.words(logBetween(rng, 2000, 120_000)));
    }
    const summary = { id, file, title, notes, bytes: written.bytes, messages: written.messages, entries: written.entries, windows: written.windows, cwd };
    if (companion) manifest.conversations.companion = summary;
    else if (item.kind === 'large') manifest.conversations.large.push(summary);
    else if (!legacy && written.bytes > 20_000 * scale && written.bytes < 200_000 * Math.max(scale, 0.05) && written.messages >= 10) manifest.conversations.small = summary;
    if (!companion && item.kind !== 'large' && endedAt >= now - 86_400_000) manifest.conversations.recent.push(summary);
    if ((index + 1) % 200 === 0) log(`conversations ${index + 1}/${plan.length}, ${(totalBytes / 1e9).toFixed(2)} GB`);
  }
  manifest.conversations.large.sort((a, b) => b.bytes - a.bytes);
  manifest.conversations.recent = manifest.conversations.recent.slice(-20);

  // Speed-index samples: one file per process start, spread over the last 20 days.
  const samplesDir = path.join(agentDir, 'speed-index', 'samples');
  let sampleBytes = 0;
  for (let i = 0; i < o.samples; i += 1) {
    const startedAt = now - Math.floor(rng() * 20 * 86_400_000);
    const lines = Math.max(1, Math.round(logBetween(rng, 5, 300) * Math.min(1, scale * 4)));
    const text = Array.from({ length: lines }, (_, n) => JSON.stringify(speedSample(rng, startedAt + n * 30_000, startedAt))).join('\n') + '\n';
    writeFileSync(path.join(samplesDir, `${startedAt}-${10_000 + i}-${hex(rng, 8)}.jsonl`), text);
    sampleBytes += text.length;
  }

  // The engine's session index, written by the engine's own listing (pi-server session-files.mjs).
  if (o.index) {
    const { SessionFiles } = await import('../pi-server/src/session-files.mjs');
    const files = new SessionFiles(sessionsDir, { indexPath: path.join(agentDir, 'server', 'session-index.json') });
    mkdirSync(path.join(agentDir, 'server'), { recursive: true, mode: 0o700 });
    const listed = await files.list();
    await files.close();
    manifest.totals.listed = listed.length;
  }
  manifest.totals = { ...manifest.totals, conversations: plan.length, conversationBytes: totalBytes, notesArchives: archives,
    speedSamples: o.samples, speedSampleBytes: sampleBytes };
  writeFileSync(path.join(o.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, sessions: { type: 'string' }, artifacts: { type: 'string' }, large: { type: 'string' },
    'companion-mb': { type: 'string' }, samples: { type: 'string' }, 'size-scale': { type: 'string' }, seed: { type: 'string' },
    now: { type: 'string' }, 'model-port': { type: 'string' }, 'no-index': { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !values.out) {
    console.log(`Usage: node harness/bench/aged-profile.mjs --out /absolute/dir [--size-scale ${DEFAULTS.sizeScale}] [--sessions ${DEFAULTS.sessions}]
  [--artifacts ${DEFAULTS.artifacts}] [--large ${DEFAULTS.large}] [--companion-mb ${DEFAULTS.companionMb}] [--samples ${DEFAULTS.samples}]
  [--seed ${DEFAULTS.seed}] [--now <epoch ms>] [--model-port ${DEFAULTS.modelPort}] [--no-index] [--force]`);
    process.exitCode = values.out ? 0 : 1;
  } else {
    const number = (key, fallback) => (values[key] === undefined ? fallback : Number(values[key]));
    const began = performance.now();
    const manifest = await generateAgedProfile({ out: path.resolve(values.out), sessions: number('sessions', DEFAULTS.sessions),
      artifacts: number('artifacts', DEFAULTS.artifacts), large: values.large ?? DEFAULTS.large, companionMb: number('companion-mb', DEFAULTS.companionMb),
      samples: number('samples', DEFAULTS.samples), sizeScale: number('size-scale', DEFAULTS.sizeScale), seed: number('seed', DEFAULTS.seed),
      now: values.now === undefined ? undefined : Number(values.now), modelPort: number('model-port', DEFAULTS.modelPort),
      index: !values['no-index'], force: values.force });
    console.log(JSON.stringify({ out: values.out, seconds: Math.round((performance.now() - began) / 1000), ...manifest.totals,
      companion: manifest.conversations.companion && { id: manifest.conversations.companion.id, mb: +(manifest.conversations.companion.bytes / 1e6).toFixed(1),
        messages: manifest.conversations.companion.messages, entries: manifest.conversations.companion.entries, windows: manifest.conversations.companion.windows } }, null, 2));
  }
}
