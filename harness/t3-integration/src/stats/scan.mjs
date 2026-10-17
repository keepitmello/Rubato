// One session log or one speed sample file, reduced to what the Stats page counts.
// Pure: text in, summary out. The worker (scan-worker.mjs) owns files and the cache.
//
// A session log is JSONL. The lines read here:
//   {type:"session", cwd, timestamp}              first line; a file without it is not a session
//   {type:"session_info", name}                    the title, the last one wins
//   {type:"thinking_level_change", thinkingLevel}  the level the next messages go out with
//   {type:"message", message:{role:"user"|"assistant", ...}}
// Tool results are the bulk of a log and are never parsed.

export const SUMMARY_VERSION = 3;

/** Local calendar day of an epoch ms, YYYY-MM-DD. */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) if (part && part.type === 'text' && typeof part.text === 'string') text += part.text;
  return text;
}

/**
 * A message the person typed. Runtime notices, wakes and injected context reach
 * the log as user messages too; they all open with a tag.
 */
export function isTypedUserText(text) {
  const trimmed = text.trimStart();
  return trimmed.length > 0 && !trimmed.startsWith('<');
}

function keepTop(map, day, row) {
  const held = map[day];
  if (!held || row[0] > held[0]) map[day] = row;
}

/**
 * Line-at-a-time form for streams: push() returns false once the first line shows
 * the file is not a session log; finish() returns the summary or null.
 */
export function createSessionSummarizer() {
  const summary = {
    v: SUMMARY_VERSION,
    cwd: null,
    title: null,
    start: null,
    end: null,
    turns: [],
    levels: [],
    usage: {},
    agents: [],
    teams: [],
    thinks: {},
    runs: {},
    // [start, end] of each stretch the agent worked: from something reaching it (a typed
    // message, a system wake, a runtime notice or completion) to its last reply before the
    // next one. Waiting is not in it.
    work: [],
  };
  let first = true;
  let level = null;
  let run = null;
  let stretch = null;
  const closeStretch = () => {
    if (stretch && stretch.end > stretch.start) summary.work.push([stretch.start, stretch.end]);
    stretch = null;
  };
  const closeRun = () => {
    if (run && run.calls > 0) keepTop(summary.runs, dayKey(run.start), [run.calls, Math.round((run.last - run.start) / 1000), run.start]);
    run = null;
  };
  let rejected = false;
  const push = (line) => {
    if (rejected) return false;
    if (!line) return true;
    if (first) {
      first = false;
      let head;
      try { head = JSON.parse(line); } catch { head = null; }
      if (!head || head.type !== 'session') { rejected = true; return false; }
      summary.cwd = typeof head.cwd === 'string' ? head.cwd : null;
      const at = Date.parse(head.timestamp ?? '');
      if (Number.isFinite(at)) summary.start = summary.end = at;
      return true;
    }
    // A runtime notice or completion can wake an idle session. It starts a stretch; its
    // body can be large, so only the timestamp (written last) is read.
    if (line.startsWith('{"type":"custom_message"')) {
      const mark = line.lastIndexOf('"timestamp":"');
      const at = mark < 0 ? NaN : Date.parse(line.slice(mark + 13, line.indexOf('"', mark + 13)));
      if (Number.isFinite(at)) {
        closeStretch();
        stretch = { start: at, end: at };
      }
      return true;
    }
    // Cheap gates before JSON.parse: tool results and custom entries are most of the bytes.
    if (line.includes('"role":"toolResult"')) return true;
    if (!(line.startsWith('{"type":"message"') || line.startsWith('{"type":"session_info"') || line.startsWith('{"type":"thinking_level_change"'))) return true;
    let entry;
    try { entry = JSON.parse(line); } catch { return true; }
    const at = Date.parse(entry.timestamp ?? '');
    if (!Number.isFinite(at)) return true;
    summary.start ??= at;
    if (at > summary.end) summary.end = at;
    if (entry.type === 'session_info') {
      if (typeof entry.name === 'string' && entry.name.trim()) summary.title = entry.name.trim();
      return true;
    }
    if (entry.type === 'thinking_level_change') {
      if (typeof entry.thinkingLevel === 'string') level = entry.thinkingLevel;
      return true;
    }
    const message = entry.message;
    if (!message) return true;
    if (message.role === 'user' || message.role === 'system') {
      closeStretch();
      stretch = { start: at, end: at };
      if (message.role === 'system' || !isTypedUserText(textOf(message.content))) return true;
      closeRun();
      summary.turns.push(at);
      summary.levels.push(level);
      return true;
    }
    if (message.role !== 'assistant') return true;
    if (stretch) stretch.end = at;
    else stretch = { start: at, end: at };
    const model = typeof message.model === 'string' && message.model ? message.model : 'unknown';
    const usage = message.usage ?? {};
    const key = `${dayKey(at)}|${model}`;
    const row = (summary.usage[key] ??= [0, 0, 0, 0, 0]);
    row[0] += 1;
    row[1] += num(usage.input);
    row[2] += num(usage.cacheRead);
    row[3] += num(usage.cacheWrite);
    row[4] += num(usage.output);
    if (run) { run.calls += 1; run.last = at; } else run = { calls: 1, start: at, last: at };
    if (!Array.isArray(message.content)) return true;
    for (const part of message.content) {
      if (!part) continue;
      if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.length > 0) {
        keepTop(summary.thinks, dayKey(at), [part.thinking.length, model, at, entry.id ?? null]);
      } else if (part.type === 'toolCall') {
        const args = part.arguments ?? {};
        if (part.name === 'Agent') summary.agents.push([at, typeof args.model === 'string' ? args.model : typeof args.preset === 'string' ? `preset:${args.preset}` : 'default']);
        else if (part.name === 'team_create') summary.teams.push(at);
      }
    }
    return true;
  };
  const finish = () => {
    closeRun();
    closeStretch();
    if (rejected || first || summary.start === null) return null;
    return summary;
  };
  return { push, finish };
}

/** @param {Iterable<string>} lines */
export function summarizeSession(lines) {
  const summarizer = createSessionSummarizer();
  for (const line of lines) if (!summarizer.push(line)) break;
  return summarizer.finish();
}

/**
 * Speed samples as [day, model, ratio] rows; ratio > 1 is faster than the ruler.
 * @param {Iterable<string>} lines
 * @param {{ isScoreableSample(s: object): boolean, speedRatio(s: object): number | undefined }} speed
 */
export function summarizeSpeedSamples(lines, speed) {
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    let sample;
    try { sample = JSON.parse(line); } catch { continue; }
    if (!speed.isScoreableSample(sample)) continue;
    const at = Date.parse(sample.at ?? '');
    const ratio = speed.speedRatio(sample);
    if (!Number.isFinite(at) || !(ratio > 0) || typeof sample.model !== 'string') continue;
    rows.push([dayKey(at), sample.model, Math.round(ratio * 10000) / 10000]);
  }
  return rows;
}
