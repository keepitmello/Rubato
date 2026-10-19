// The companion's one way out to a messenger: `telegram_send`.
//
// Segno writes; this tool queues. Nothing is sent from the runtime, so a message to anyone but
// the person waits in the companion's own store until they approve it (harness/companion/messenger
// service.mjs sends it, or refuses it). The rule is in the code, not in a prompt: the tool has no
// path to Telegram at all.
import { enqueueMessage } from "../../../companion/messenger/store.mjs";

export const TELEGRAM_SEND_TOOL = "telegram_send";

export function sendTelegram(details, env = process.env) {
  const to = details?.to;
  const text = details?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("text must be a non-empty message");
  const target = to === undefined || to === null || to === "" || to === "user" ? "user" : { chatId: String(to), name: typeof details?.name === "string" ? details.name : String(to) };
  const row = enqueueMessage({ text: text.trim(), target, source: "tool" }, env);
  return row;
}

function toolText(row) {
  return row.target === "user"
    ? "Queued for the person's Telegram."
    : `Held for the person's approval before it goes anywhere (${row.id}). It is sent only if they approve it.`;
}

export function createCompanionMessengerFactories() {
  return [{
    name: "companion-messenger",
    factory: (pi) => {
      pi.registerTool({
        name: TELEGRAM_SEND_TOOL,
        label: "Telegram",
        exposure: "direct",
        searchKeywords: ["telegram", "message", "send", "reply", "bug report", "메시지", "텔레그램"],
        description:
          "Send a message to the person on Telegram, or to another chat the person has shown you " +
          "(a group where bug reports arrive, named by its chat id or title). " +
          "A message to anyone but the person is held for their approval before it is sent: " +
          "say what you wrote and that it waits for them. Plain text only.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, description: "The message, as it should read in Telegram." },
            to: { type: "string", description: "The chat id or title of another chat. Leave it out for the person's own chat." },
            name: { type: "string", description: "What to call that chat in the approval the person sees." },
          },
        },
        async execute(_id, params) {
          const row = sendTelegram(params);
          return { content: [{ type: "text", text: toolText(row) }], details: { id: row.id, state: row.state, target: row.target } };
        },
      });
    },
  }];
}

export default createCompanionMessengerFactories;

