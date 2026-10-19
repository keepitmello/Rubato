// The companion's one way out to a messenger: `telegram_send`.
//
// Segno writes; the engine's resident messenger decides. The tool is a thin call into the
// engine's `sessionLink.telegramSend`, which queues the message in the messenger's own store
// (harness/companion/messenger); a message to anyone but the person waits there until they
// approve it. The rule is in the code, not in a prompt: this file has no path to Telegram.
export const TELEGRAM_SEND_TOOL = "telegram_send";

function text(value) {
  return { type: "text", text: value };
}

function answer(row) {
  if (!row || row.target === "user") return "Queued for the person's Telegram.";
  return `Held for the person's approval before it goes anywhere (${row.id}). It is sent only if they approve it.`;
}

export function createCompanionMessengerFactories({ sessionLink } = {}) {
  if (!sessionLink?.telegramSend) return [];
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
          const row = await sessionLink.telegramSend({ text: params.text, to: params.to, name: params.name });
          return { content: [text(answer(row))], details: { id: row?.id, state: row?.state, target: row?.target } };
        },
      });
    },
  }];
}

export default createCompanionMessengerFactories;
