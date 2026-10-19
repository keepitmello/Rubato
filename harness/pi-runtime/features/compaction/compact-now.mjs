// The companion's own compaction (harness/prompts/companion, its sleep). The companion is one
// conversation that lives for months; on a quiet night it may choose to carry on in a smaller
// context instead of a new window. Its model compacts on the server only at the safety line
// (anthropic-server-compaction-wire.mjs), and in notes mode `/compact` opens a new window, so
// `compact_context` makes the next request carry the server-compaction edit once with Anthropic's
// minimum trigger. The server summarizes; the adapter keeps and resends that block as it does at
// the safety line.
import { anthropicServerCompactionArmed, supportsAnthropicServerCompaction } from "./anthropic-server-compaction.mjs";
import { compactNowPayload } from "./anthropic-server-compaction-wire.mjs";

export const COMPACT_CONTEXT_TOOL = "compact_context";
export const COMPACT_NOW_FACTORY_NAME = "rubato-compact-now";

const text = (value) => ({ type: "text", text: value });

// Pi's cache warmer replays the last request with max_tokens 1 (core/cache-warmer.js); a
// compaction there would be thrown away with its answer.
const isCacheWarm = (payload) => payload?.max_tokens === 1;

/**
 * @param {{ armed?: () => boolean }} [options] whether the server-compaction adapter is in place
 *   (both transforms applied); without it a compaction block would be dropped.
 */
export function createCompactNowExtension({ armed = anthropicServerCompactionArmed } = {}) {
  return (pi) => {
    let pending = false;
    pi.registerTool({
      name: COMPACT_CONTEXT_TOOL,
      label: "Compact",
      exposure: "direct",
      searchKeywords: ["compact", "compaction", "sleep", "context", "summary", "압축", "잠"],
      description:
        "Compact this conversation now and carry on in the same window: the next request asks the " +
        "server to summarize the history above about 50k tokens. Use it when going to sleep with work " +
        "still alive, after your records and notes are written. On a model without server compaction " +
        "it does nothing and says so; there, a smaller context is a new window (new_context).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const model = ctx?.model;
        if (!supportsAnthropicServerCompaction(model) || !armed()) {
          pending = false;
          const name = model?.id ?? "this model";
          return { content: [text(`${name} has no server compaction here, so nothing was compacted. For a smaller context, call new_context.`)],
            details: { compacting: false } };
        }
        pending = true;
        return { content: [text("The next request compacts this conversation on the server. Finish the turn with a short line; the summary carries the rest.")],
          details: { compacting: true } };
      },
    });
    pi.on("before_provider_request", (event) => {
      if (!pending || isCacheWarm(event.payload)) return undefined;
      pending = false;
      return compactNowPayload(event.payload) ?? undefined;
    });
  };
}

export function createCompactNowExtensionFactories(options) {
  return [{ name: COMPACT_NOW_FACTORY_NAME, factory: createCompactNowExtension(options) }];
}
