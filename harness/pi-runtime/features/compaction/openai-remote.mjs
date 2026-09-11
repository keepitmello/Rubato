import {
  isOpenAiRemoteCompactionModel,
  openAiRemoteCompactionEndpointUrl,
} from "./openai-remote-model.mjs";

export const OPENAI_REMOTE_COMPACTION_SCHEMA = "rubato.openai-remote-compaction.v1";
const TIMEOUT_MS = 15_000;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function convertBranchEntries(branchEntries) {
  const input = [];
  for (const entry of branchEntries ?? []) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = typeof message.content === "string"
      ? message.content
      : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!text) continue;
    input.push({ type: "message", role, content: text });
  }
  return input;
}

export function createOpenAiRemoteCompactionRequest({ model, branchEntries, systemPrompt, tokensBefore }) {
  if (!isOpenAiRemoteCompactionModel(model)) return undefined;
  const input = convertBranchEntries(branchEntries);
  if (input.length === 0) return undefined;
  return {
    body: {
      model: model.id,
      input,
      ...(systemPrompt ? { instructions: systemPrompt } : {}),
    },
    inputItemCount: input.length,
    tokensBefore,
  };
}

function findCompactionItem(output) {
  return (output ?? []).find((item) => item && (item.type === "compaction" || item.type === "context_compaction" || item.encrypted_content));
}

export async function runOpenAiRemoteCompaction({
  model,
  event,
  systemPrompt,
  fetchImpl = fetch,
  auth = {},
  now = Date.now,
  remoteTimeoutMs = TIMEOUT_MS,
} = {}) {
  const request = createOpenAiRemoteCompactionRequest({
    model,
    branchEntries: event.branchEntries,
    systemPrompt,
    tokensBefore: event.preparation?.tokensBefore ?? 0,
  });
  if (!request) return undefined;
  const url = openAiRemoteCompactionEndpointUrl(model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remoteTimeoutMs);
  event.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const headers = { "content-type": "application/json", ...(auth.headers ?? {}) };
    if (auth.apiKey && !headers.authorization) headers.authorization = `Bearer ${auth.apiKey}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenAI remote compaction HTTP ${response.status}`);
    const value = await response.json();
    if (!isRecord(value) || !Array.isArray(value.output) || !findCompactionItem(value.output)) {
      throw new Error("OpenAI remote compaction did not return a compaction item");
    }
    const firstKeptEntryId = event.preparation?.firstKeptEntryId;
    if (!firstKeptEntryId) throw new Error("OpenAI remote compaction is missing firstKeptEntryId");
    return {
      summary: [
        "OpenAI remote compaction checkpoint.",
        `Native compact-endpoint replay is active for ${value.output.length} retained item(s).`,
        `Original OpenAI input items compacted: ${request.inputItemCount}.`,
      ].join("\n"),
      firstKeptEntryId,
      tokensBefore: request.tokensBefore,
      details: {
        schema: OPENAI_REMOTE_COMPACTION_SCHEMA,
        mode: "openai-remote",
        transport: "compact-endpoint",
        modelId: model.id,
        responseId: typeof value.id === "string" ? value.id : `compact:${now()}`,
        requestInputItemCount: request.inputItemCount,
        retainedInputItemCount: value.output.length,
        replacementInput: value.output,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
