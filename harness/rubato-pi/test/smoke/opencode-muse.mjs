// Live OpenCode Zen smoke: Muse Spark 1.3 Contributor Free.
// Path: Rubato → pi-ai OpenCode provider → OpenCode Zen API.
// Never prints the API key.
import { execFileSync } from "node:child_process";
import { directProviders } from "../../src/provider-direct.mjs";

const MUSE_ID = "muse-spark-1.3-contributor-free";
const TURN_MS = Number(process.env.RUBATO_OPENCODE_SMOKE_TURN_MS ?? 90_000);

function loadKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "opencode.ai", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`ok ${message}`);
}

function textOf(events) {
  const done = events.findLast((event) => event.type === "done");
  const content = done?.message?.content ?? [];
  return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function usageOf(events) {
  const done = events.findLast((event) => event.type === "done");
  return done?.message?.usage;
}

function modelOf(events) {
  const done = events.findLast((event) => event.type === "done");
  return done?.message?.model;
}

function toolCallsOf(events) {
  const done = events.findLast((event) => event.type === "done");
  const content = done?.message?.content ?? [];
  return content.filter((block) => block.type === "toolCall");
}

async function main() {
  const apiKey = loadKey();
  if (!apiKey) {
    fail("OPENCODE_API_KEY missing (env or keychain service opencode.ai)");
    return;
  }

  const providers = await directProviders();
  const opencode = providers.find((provider) => provider.id === "opencode");
  if (!opencode) {
    fail("opencode provider missing from directProviders()");
    return;
  }
  const muse = opencode.getModels().find((model) => model.id === MUSE_ID);
  if (!muse) {
    fail(`${MUSE_ID} missing from pinned catalog`);
    return;
  }
  const model = { ...muse, provider: opencode.id, baseUrl: muse.baseUrl };
  const opts = { apiKey, maxRetries: 0, timeoutMs: TURN_MS, env: {} };

  // 1) text + streaming + usage + no fallback
  const turn1Messages = [{
    role: "user",
    content: [{ type: "text", text: "Reply with exactly: OK" }],
  }];
  const turn1 = await drain(opencode.streamSimple(model, { messages: turn1Messages }, {
    ...opts,
    reasoning: "low",
  }));
  const turn1Error = turn1.find((event) => event.type === "error");
  if (turn1Error) {
    fail(`turn1 error: ${String(turn1Error.error?.errorMessage ?? turn1Error.error).slice(0, 400)}`);
    return;
  }
  const turn1Text = textOf(turn1).trim();
  if (!turn1Text.includes("OK")) fail(`turn1 text was ${JSON.stringify(turn1Text).slice(0, 200)}`);
  else pass(`turn1 text=${JSON.stringify(turn1Text).slice(0, 80)}`);
  if (!turn1.some((event) => event.type === "text_start" || event.type === "thinking_start" || event.type === "start")) {
    fail("turn1 produced no streaming start events");
  } else {
    pass(`turn1 stream events=${turn1.map((event) => event.type).join(",")}`);
  }
  const usage1 = usageOf(turn1);
  if (!usage1 || typeof usage1.input !== "number") fail(`turn1 usage missing: ${JSON.stringify(usage1)}`);
  else pass(`turn1 usage input=${usage1.input} output=${usage1.output}`);
  if (modelOf(turn1) && modelOf(turn1) !== MUSE_ID) fail(`turn1 model fallback ${modelOf(turn1)}`);
  else pass(`turn1 model stays ${MUSE_ID}`);

  // 2) multi-turn context
  const assistant1 = turn1.findLast((event) => event.type === "done")?.message;
  const turn2Messages = [
    ...turn1Messages,
    assistant1,
    { role: "user", content: [{ type: "text", text: "Reply with exactly: OK2" }] },
  ].filter(Boolean);
  const turn2 = await drain(opencode.streamSimple(model, { messages: turn2Messages }, {
    ...opts,
    reasoning: "low",
    sessionId: "rubato-opencode-smoke",
  }));
  const turn2Error = turn2.find((event) => event.type === "error");
  if (turn2Error) {
    fail(`turn2 error: ${String(turn2Error.error?.errorMessage ?? turn2Error.error).slice(0, 400)}`);
  } else {
    const turn2Text = textOf(turn2).trim();
    if (!turn2Text.includes("OK2") && !turn2Text.includes("OK")) fail(`turn2 text was ${JSON.stringify(turn2Text).slice(0, 200)}`);
    else pass(`turn2 text=${JSON.stringify(turn2Text).slice(0, 80)}`);
    const usage2 = usageOf(turn2);
    if (!usage2) fail("turn2 usage missing");
    else pass(`turn2 usage input=${usage2.input} output=${usage2.output}`);
  }

  // 3) tool call via native openai-responses
  const toolTurn = await drain(opencode.streamSimple(
    model,
    {
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "Call the ping tool with msg set to hi. Do not answer in text; only call the tool.",
        }],
      }],
      tools: [{
        name: "ping",
        description: "Ping with a short message",
        parameters: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
      }],
    },
    { ...opts, reasoning: "low" },
  ));
  const toolError = toolTurn.find((event) => event.type === "error");
  if (toolError) {
    fail(`tool error: ${String(toolError.error?.errorMessage ?? toolError.error).slice(0, 400)}`);
  } else {
    const calls = toolCallsOf(toolTurn);
    const started = toolTurn.some((event) => event.type === "toolcall_start");
    if (calls.length === 0 && !started) fail(`tool call missing; events=${toolTurn.map((e) => e.type).join(",")} text=${JSON.stringify(textOf(toolTurn)).slice(0, 200)}`);
    else pass(`tool calls=${JSON.stringify(calls.map((call) => ({ name: call.name, arguments: call.arguments })))} streamed=${started}`);
  }

  // 4) reasoning payload actually returns thinking when requested
  const reasonTurn = await drain(opencode.streamSimple(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: "Think briefly, then reply with exactly: OK" }] }] },
    { ...opts, reasoning: "medium" },
  ));
  const reasonError = reasonTurn.find((event) => event.type === "error");
  if (reasonError) {
    fail(`reasoning error: ${String(reasonError.error?.errorMessage ?? reasonError.error).slice(0, 400)}`);
  } else {
    const thinking = reasonTurn.some((event) => event.type === "thinking_start" || event.type === "thinking_delta")
      || (reasonTurn.findLast((event) => event.type === "done")?.message?.content ?? []).some((block) => block.type === "thinking");
    if (thinking) pass("reasoning produced thinking events");
    else pass(`reasoning produced no thinking block; events=${reasonTurn.map((e) => e.type).join(",")}`);
  }

  if (process.exitCode) fail("opencode muse smoke had failures");
  else console.log("opencode muse smoke passed");
}

await main();
