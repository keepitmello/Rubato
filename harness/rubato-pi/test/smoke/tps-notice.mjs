// Component-first smoke: footer Speed segment + silent owned tps shim.
// Run: `node test/smoke/tps-notice.mjs`
import assert from "node:assert/strict";
import { installStatusline } from "../../src/extensions/statusline.mjs";
import { installTps } from "../../src/extensions/tps.mjs";

function mockStore(result) {
  return {
    clearActiveIdentity() {},
    refresh() {},
    getCachedScore() { return result; },
  };
}

function renderFooter(result, width = 160) {
  let factory;
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 400_000, contextWindow: 1_000_000, percent: 40 }),
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 20, cacheRead: 80, cacheWrite: 0, output: 17 },
            timing: { processStartedAt: 42, waitMs: 4_000, thinkMs: 10_000, modelDurationMs: 1_000 },
          },
        },
      ],
    },
    ui: { setFooter(next) { factory = next; } },
  };
  const pi = { on(event, handler) { if (event === "session_start") handler({}, ctx); } };
  installStatusline(pi, { processStartedAt: 42, speedStore: mockStore(result) });
  const footer = factory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
  );
  return footer.render(width).join("\n");
}

function assertNoLegacy(text) {
  assert.doesNotMatch(text, /tok\/s|\bTPS\b|\bdelay\b|\bthink\b/);
}

const dash = renderFooter({ status: "unavailable", reason: "no_baseline" });
assert.match(dash, /Speed —/);
assert.match(dash, /Cache 80%/);
assertNoLegacy(dash);

// A single matched call in this session is a real score: no `~N` form remains.
const single = renderFooter({ status: "ready", score: 91, matched: 1 });
assert.match(single, /Speed 91/);
assert.doesNotMatch(single, /Speed ~/);
assertNoLegacy(single);

const ready = renderFooter({ status: "ready", score: 108 });
assert.match(ready, /Speed 108/);
assertNoLegacy(ready);

const tight = renderFooter({ status: "ready", score: 108 }, 70);
assert.match(tight.split("\n")[0], /Cache 80%/);
assert.equal(tight.split("\n")[0].includes("Speed"), false);
assert.match(tight.split("\n")[1], /Speed 108/);
assertNoLegacy(tight);

const notices = [];
const handlers = new Map();
installTps({ on: (name, fn) => handlers.set(name, fn) });
const ctx = { hasUI: true, ui: { notify: (text, level) => notices.push({ text, level }) } };
assert.equal(handlers.size, 0);
assert.deepEqual(notices, []);

console.log("tps-notice smoke ok");
console.log("DASH:", dash);
console.log("READY:", ready);
console.log("TIGHT:", tight);
