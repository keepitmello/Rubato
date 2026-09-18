import assert from "node:assert/strict";
import test from "node:test";
import {
  applyThinkingDisplay,
  isOmittedThinkingDisplayModel,
  shouldRewriteThinkingDisplay,
  wrapThinkingDisplayFetch,
} from "../../src/thinking-display.mjs";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

function payload({ model = "claude-fable-5-1", display = "summarized", extra } = {}) {
  return {
    model,
    max_tokens: 64,
    thinking: { type: "adaptive", display },
    output_config: { effort: "high" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    stream: true,
    ...extra,
  };
}

test("Fable 5.1 and sibling always-on models use official omitted display", () => {
  assert.equal(isOmittedThinkingDisplayModel("claude-fable-5-1"), true);
  assert.equal(isOmittedThinkingDisplayModel("anthropic.claude-fable-5-1"), true);
  assert.equal(isOmittedThinkingDisplayModel("claude-opus-5"), true);
  assert.equal(isOmittedThinkingDisplayModel("claude-sonnet-4-6"), false);
  assert.equal(isOmittedThinkingDisplayModel("claude-haiku-4-5"), false);
});

test("rewrites summarized thinking display to omitted on Fable 5.1", () => {
  const raw = JSON.stringify(payload());
  const applied = applyThinkingDisplay(raw, { provider: "anthropic" });
  assert.equal(applied.rewritten, true);
  assert.equal(JSON.parse(applied.bodyText).thinking.display, "omitted");
  assert.equal(JSON.parse(applied.bodyText).thinking.type, "adaptive");
});

test("gate is a no-op when the request is already omitted or not Fable-class", () => {
  const cases = [
    { label: "already omitted", body: payload({ display: "omitted" }), provider: "anthropic" },
    { label: "updates stay", body: payload({ display: "updates" }), provider: "anthropic" },
    { label: "wrong model", body: payload({ model: "claude-sonnet-4-6" }), provider: "anthropic" },
    { label: "wrong provider", body: payload(), provider: "amazon-bedrock" },
    { label: "no thinking", body: payload({ extra: { thinking: undefined } }), provider: "anthropic" },
  ];
  for (const { label, body, provider } of cases) {
    const raw = JSON.stringify(body);
    const applied = applyThinkingDisplay(raw, { provider });
    assert.equal(applied.rewritten, false, label);
    assert.equal(applied.bodyText, raw, `${label}: body bytes`);
  }
  assert.equal(shouldRewriteThinkingDisplay({ body: payload(), provider: "anthropic" }), true);
});

test("fetch wrapper only rewrites Anthropic messages bodies", async () => {
  const seen = [];
  const fetchImpl = wrapThinkingDisplayFetch(async (_url, init) => {
    seen.push(init);
    return new Response("{}", { status: 200 });
  }, { provider: "anthropic" });

  const summarized = JSON.stringify(payload());
  await fetchImpl(MESSAGES_URL, { method: "POST", body: summarized });
  assert.equal(JSON.parse(seen[0].body).thinking.display, "omitted");

  const other = JSON.stringify(payload());
  await fetchImpl("https://api.anthropic.com/v1/models", { method: "POST", body: other });
  assert.equal(seen[1].body, other);
});
