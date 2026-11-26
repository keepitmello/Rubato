import assert from "node:assert/strict";
import test from "node:test";
import { MonitorNotifier } from "./src/monitor-notify.ts";
import { resolveTerminalSettings, TERMINAL_SETTINGS_DEFAULTS } from "./src/settings.ts";
import { TerminalNotifier } from "./src/notify.ts";
import { IntermediateWakeBudget, INTERMEDIATE_WAKE_LIMIT, WAKE_LIMIT_NOTICE } from "./src/wake-budget.ts";
import { TerminalSessionBundle } from "./src/session-bundle.ts";

function fixture(extra = {}) {
  let now = 0;
  const timers = new Map();
  const sent = [];
  const paused = [];
  const notifier = new MonitorNotifier({
    sendMessage: (message, options) => sent.push({ message, options }),
    getContext: () => ({ model: {}, mode: "rpc" }),
    getMode: () => "wake",
    getSettings: () => ({ ...TERMINAL_SETTINGS_DEFAULTS.monitor, coalesceWindowMs: 1, rateLimitMs: 1 }),
    pauseMonitors: ids => { paused.push(...ids); return ids; },
    scheduler: {
      now: () => now,
      setTimeout: fn => { const id = Symbol(); timers.set(id, fn); return id; },
      clearTimeout: id => timers.delete(id),
    },
    ...extra,
  });
  const event = (value) => {
    now += 60_000;
    notifier.notifyEvent(value);
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
  };
  return { notifier, sent, paused, event };
}

test("a slow monitor cannot reset its three-wake limit by rearming", () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    f.notifier.rearm("watch");
    f.event({ type: "line", id: "watch", description: "test progress", line: `still running ${i}` });
  }
  assert.equal(f.sent.filter(entry => entry.options.triggerTurn).length, INTERMEDIATE_WAKE_LIMIT);
  assert.ok(f.paused.includes("watch"));
  f.event({ type: "summary", id: "watch", description: "test progress", summary: "watcher completed", cutShort: false });
  assert.equal(f.sent.at(-1).options.triggerTurn, true, "the final result still wakes the session");
  f.event({ type: "line", id: "watch", description: "next test", line: "a new test run" });
  assert.equal(f.sent.at(-1).options.triggerTurn, true, "a genuinely completed job does not mute the next job");
});

const job = () => ({
  exited: false, killedByAgent: false, waitOvertaken: false, waitingOn: undefined,
  exitResult: { exitCode: 0 }, fullOutput: () => "6",
});

test("an older higher configured monitor allowance cannot bypass the hard ceiling", () => {
  assert.equal(resolveTerminalSettings({ monitorWakeBudget: 100 }).monitor.wakeBudget, INTERMEDIATE_WAKE_LIMIT);
});

test("replacement monitors and detached sleep checks share the target job's allowance; real outcomes still wake", () => {
  const wakeBudget = new IntermediateWakeBudget();
  const target = job();
  const runtimes = new Map();
  const f = fixture({ wakeBudget, getRuntime: id => runtimes.get(id) });
  const terminal = new TerminalNotifier({
    wakeBudget, getContext: () => ({ model: {}, mode: "rpc" }), getMode: () => "wake",
    sendMessage: (message, options) => f.sent.push({ message, options }),
  });
  for (let i = 0; i < INTERMEDIATE_WAKE_LIMIT + 3; i++) {
    const id = `new-watcher-${i}`;
    const runtime = { ...job(), waitingOn: [target] };
    runtimes.set(id, runtime);
    if (i % 2) terminal.notifyCompletion(id, runtime);
    else f.event({ type: "summary", id, description: `exam ${i}`, summary: "watcher timed_out", cutShort: true });
  }
  assert.equal(f.sent.filter(entry => entry.options.triggerTurn).length, INTERMEDIATE_WAKE_LIMIT);
  assert.ok(f.sent.some(entry => entry.message.content.includes(WAKE_LIMIT_NOTICE)));
  assert.equal(target.exited, false, "blocking wakes never stops the actual job");
  terminal.notifyCompletion("real-result", target);
  assert.equal(f.sent.at(-1).options.triggerTurn, true);
  terminal.notifyCompletion("actual-failure", { ...job(), exitResult: { exitCode: 1 } });
  assert.equal(f.sent.at(-1).options.triggerTurn, true);
  assert.match(f.sent.at(-1).message.content, /exit code 1/);
  // A different job gets its own allowance; a message from the person refills the old one.
  terminal.notifyCompletion("different-job-check", { ...job(), waitingOn: [job()] });
  assert.equal(f.sent.at(-1).options.triggerTurn, true);
  f.notifier.notePersonInput();
  terminal.notifyCompletion("after-person", { ...job(), waitingOn: [target] });
  assert.equal(f.sent.at(-1).options.triggerTurn, true);
});

test("an observer exiting successfully is still an intermediate check, not the watched job's completion", () => {
  const target = job();
  const f = fixture({ getRuntime: () => ({ ...job(), waitingOn: [target] }) });
  for (let i = 0; i < INTERMEDIATE_WAKE_LIMIT + 2; i++) {
    f.event({ type: "summary", id: `wait-${i}`, description: "same pending build", summary: "watcher completed", cutShort: false });
  }
  assert.equal(f.sent.filter(entry => entry.options.triggerTurn).length, INTERMEDIATE_WAKE_LIMIT);
});

test("a recreated command keeps its allowance even when its description and id change", () => {
  const f = fixture({ getRuntime: () => ({ ...job(), spawned: { command: "tail -f build.log", cwd: "/work" } }) });
  for (let i = 0; i < INTERMEDIATE_WAKE_LIMIT + 2; i++) {
    f.event({ type: "line", id: `new-${i}`, description: `different label ${i}`, line: `still working ${i}` });
  }
  assert.equal(f.sent.filter(entry => entry.options.triggerTurn).length, INTERMEDIATE_WAKE_LIMIT);
});

test("an extension reload retains the bundle's wake counts and a genuine new person instruction refills them", async () => {
  const bundle = new TerminalSessionBundle({});
  const target = job();
  const options = { wakeBudget: bundle.wakeBudget, getRuntime: () => ({ ...job(), waitingOn: [target] }) };
  const first = fixture(options);
  for (let i = 0; i < INTERMEDIATE_WAKE_LIMIT; i++) first.event({ type: "line", id: "old", description: "wait", line: `${i}` });
  first.notifier.dispose();
  bundle.park();
  const next = fixture(options);
  next.event({ type: "line", id: "replacement", description: "wait", line: "still waiting" });
  assert.equal(next.sent.at(-1).options.triggerTurn, false);
  next.notifier.notePersonInput();
  next.event({ type: "line", id: "replacement", description: "wait", line: "new user request" });
  assert.equal(next.sent.at(-1).options.triggerTurn, true);
  await bundle.teardown();
});

test("an exhausted watcher cannot swallow another job's completion in the same batch", () => {
  const f = fixture();
  for (let i = 0; i < INTERMEDIATE_WAKE_LIMIT; i++) f.event({ type: "line", id: "watch", description: "noisy", line: `${i}` });
  f.notifier.notifyEvent({ type: "line", id: "watch", description: "noisy", line: "still running" });
  f.event({ type: "summary", id: "other-job", description: "real result", summary: "watcher completed", cutShort: false });
  assert.equal(f.sent.at(-1).options.triggerTurn, true);
  assert.match(f.sent.at(-1).message.content, /real result/);
});

test("a completed watched job makes stale waits quiet without consuming a new job's allowance", () => {
  const wakeBudget = new IntermediateWakeBudget();
  const sent = [];
  const terminal = new TerminalNotifier({
    wakeBudget, getContext: () => ({ model: {}, mode: "rpc" }), getMode: () => "wake",
    sendMessage: (message, options) => sent.push({ message, options }),
  });
  const target = job();
  terminal.notifyCompletion("stale", { ...job(), waitingOn: [target], waitOvertaken: true });
  assert.equal(sent.at(-1).options.triggerTurn, false);
  for (let i = 0; i < INTERMEDIATE_WAKE_LIMIT; i++) terminal.notifyCompletion(`check-${i}`, { ...job(), waitingOn: [target] });
  assert.equal(sent.filter(entry => entry.options.triggerTurn).length, INTERMEDIATE_WAKE_LIMIT);
});

test("coalesced observers count one wake per job, and a suppressed multi-job check spends no fresh allowance", () => {
  const wakeBudget = new IntermediateWakeBudget();
  const target = job();
  const fresh = job();
  const f = fixture({ wakeBudget, getRuntime: id => ({ ...job(), waitingOn: id === "mixed" ? [target, fresh] : [target] }) });
  f.notifier.notifyEvent({ type: "line", id: "one", description: "observer one", line: "working" });
  f.event({ type: "line", id: "two", description: "observer two", line: "working" });
  assert.equal(f.sent.filter(entry => entry.options.triggerTurn).length, 1);
  for (let i = 1; i < INTERMEDIATE_WAKE_LIMIT; i++) f.event({ type: "line", id: "one", description: "observer one", line: `${i}` });
  assert.equal(f.sent.filter(entry => entry.options.triggerTurn).length, INTERMEDIATE_WAKE_LIMIT);
  f.event({ type: "line", id: "mixed", description: "both jobs", line: "waiting" });
  assert.equal(f.sent.at(-1).options.triggerTurn, false);
  for (let i = 0; i < INTERMEDIATE_WAKE_LIMIT; i++) assert.notEqual(wakeBudget.take([fresh]), "quiet");
  assert.equal(wakeBudget.take([fresh]), "quiet");
});
