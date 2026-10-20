// Segno's settings by talking (`companion_settings`), and its hands on Telegram, ported from Roo's
// telegram_reply, react and edit_message (~/.claude/roo-channel/pi-roo/roo-runtime.ts,
// plugins/telegram-daemon/telegram-tools.ts).
//
// The product runs no Telegram for now (harness/companion/messenger/store.mjs TELEGRAM_ENABLED), so
// the Telegram tools register only with `telegram: true`, which nothing passes; Segno speaks to the
// person in the app with `reply` (companion-home).
//
// Segno writes; the engine's resident messenger decides. Each tool is a thin call into the
// engine's `sessionLink.telegramSend`, which hands the request to the messenger
// (harness/companion/messenger): what is addressed to the person goes out at once and answers with
// its message ids, and anything addressed to another chat waits there until the person approves
// it. The rule is in the code, not in a prompt: this file has no path to Telegram.
export const TELEGRAM_SEND_TOOL = "telegram_send";
export const TELEGRAM_REACT_TOOL = "telegram_react";
export const TELEGRAM_EDIT_TOOL = "telegram_edit";
export const TELEGRAM_TOOL_NAMES = Object.freeze([TELEGRAM_SEND_TOOL, TELEGRAM_REACT_TOOL, TELEGRAM_EDIT_TOOL]);
/** Segno's settings by talking (harness/companion/settings.mjs, skill companion-settings). */
export const COMPANION_SETTINGS_TOOL = "companion_settings";

function text(value) {
  return { type: "text", text: value };
}

const TO = { type: "string", description: "The chat id or title of another chat. Leave it out for the person's own chat." };
const NAME = { type: "string", description: "What to call that chat in the approval the person sees." };

/** What the model reads back: Roo's "sent (id: …)", or that it waits for the person. */
export function describeResult(row) {
  if (!row) return "Nothing was sent.";
  if (row.state === "held") return `Held for the person's approval before it goes anywhere (${row.id}). It is sent only if they approve it.`;
  if (row.state === "queued") return row.note ?? "Queued for the person's Telegram.";
  if (row.op === "react") return "reacted";
  if (row.op === "edit") return `edited (id: ${row.messageId})`;
  const ids = row.messageIds ?? [];
  const note = row.note ?? "";
  return ids.length === 1 ? `sent (id: ${ids[0]})${note}` : `sent ${ids.length} parts (ids: ${ids.join(", ")})${note}`;
}

export function createCompanionMessengerFactories({ sessionLink, telegram = false } = {}) {
  const telegramTools = telegram === true && typeof sessionLink?.telegramSend === "function";
  const settingsTool = typeof sessionLink?.companionSettings === "function";
  if (!telegramTools && !settingsTool) return [];
  const call = async (request) => {
    const row = await sessionLink.telegramSend(request);
    return { content: [text(describeResult(row))],
      details: { id: row?.id, state: row?.state, target: row?.target, ...(row?.messageIds ? { messageIds: row.messageIds } : {}) } };
  };
  return [{
    name: "companion-messenger",
    factory: (pi) => {
      if (telegramTools) registerTelegramTools(pi, call);
      if (settingsTool) registerSettingsTool(pi, sessionLink, telegramTools);
    },
  }];
}

function registerTelegramTools(pi, call) {
  pi.registerTool({
    name: TELEGRAM_SEND_TOOL,
    label: "Telegram",
    exposure: "direct",
    searchKeywords: ["telegram", "message", "send", "reply", "voice", "file", "photo", "bug report", "메시지", "텔레그램", "음성"],
    description:
      "Send the person a Telegram message: text, files, a voice note, or text with a voice note. " +
      "Your answers in this conversation already reach the person's Telegram on their own, so use this to speak from a turn they do not see, " +
      "or to say something while you keep working. It also sends to another chat the person has shown you (a group where bug reports arrive); " +
      "a message to anyone but the person is held for their approval: say what you wrote and that it waits for them. " +
      "Telegram shows plain text. Put long material in a .md file and send the file. " +
      "voice=true sends the text and a voice note, voice=\"only\" sends only the voice note; answer in the medium the person used. " +
      "Answers with the sent message ids, which telegram_edit takes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 1, description: "The message, as it should read in Telegram." },
        files: { type: "array", maxItems: 10, items: { type: "string" }, description: "Absolute paths of files to send; images go as photos, anything else as a document." },
        voice: { anyOf: [{ type: "boolean" }, { type: "string", enum: ["only"] }], description: "true: the text and a voice note. \"only\": a voice note alone." },
        voice_text: { type: "string", minLength: 1, description: "What the voice note says, when it should differ from the text." },
        sanitize: { type: "boolean", description: "Default true: emphasis marks and voice tags come out of the text, emoticons and Markdown out of the voice. false sends both as written." },
        to: TO,
        name: NAME,
      },
    },
    async execute(_id, params) {
      return call({ text: params.text, files: params.files, voice: params.voice, voiceText: params.voice_text,
        sanitize: params.sanitize, to: params.to, name: params.name });
    },
  });
  pi.registerTool({
    name: TELEGRAM_REACT_TOOL,
    label: "Telegram reaction",
    exposure: "direct",
    searchKeywords: ["telegram", "react", "reaction", "emoji", "반응", "이모지"],
    description:
      "Put one emoji reaction on a Telegram message: by default the person's latest message to you. " +
      "Telegram accepts only its reaction emoji (👍 ❤ 🔥 🥰 👏 😁 🤔 😢 🙏 👌 😴 🤗 and the like). A reaction in another chat waits for the person's approval.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["emoji"],
      properties: {
        emoji: { type: "string", minLength: 1, description: "One reaction emoji." },
        message_id: { type: "integer", description: "The message to react to (the message attribute of a channel message). Default: the person's latest." },
        to: TO,
        name: NAME,
      },
    },
    async execute(_id, params) {
      return call({ op: "react", emoji: params.emoji, messageId: params.message_id, to: params.to, name: params.name });
    },
  });
  pi.registerTool({
    name: TELEGRAM_EDIT_TOOL,
    label: "Telegram edit",
    exposure: "direct",
    searchKeywords: ["telegram", "edit", "fix", "correct", "message", "수정", "고치기"],
    description:
      "Change the text of a Telegram message you sent, by the id telegram_send answered with. An edit in another chat waits for the person's approval.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["message_id", "text"],
      properties: {
        message_id: { type: "integer", description: "The id of your message." },
        text: { type: "string", minLength: 1, description: "The message's new text." },
        to: TO,
        name: NAME,
      },
    },
    async execute(_id, params) {
      return call({ op: "edit", messageId: params.message_id, text: params.text, to: params.to, name: params.name });
    },
  });
}

function registerSettingsTool(pi, sessionLink, telegram) {
  pi.registerTool({
    name: COMPANION_SETTINGS_TOOL,
    label: "Segno settings",
    exposure: "direct",
    searchKeywords: ["settings", "setting", "heartbeat", "greeting", "schedule", "prompt", ...(telegram ? ["voice", "telegram", "pair"] : []),
      "설정", "하트비트", "인사", "일정", ...(telegram ? ["목소리"] : [])],
    description:
      "Read or change your own settings, the ones in Settings › Companion: heartbeat, greetings, schedule sources" +
      (telegram ? ", Telegram (on/off, approval hold, voice, pairing)" : "") + " and your prompt pieces. Open the companion-settings skill first: " +
      "it says what each one does. action \"show\" gives the current values (or one prompt piece's text with piece=<id>); " +
      "action \"change\" applies a patch, checked by the same rules as the Settings page. " +
      "Only the user can change a setting: a change from a turn opened by anyone or anything else is refused." +
      (telegram ? " The bot token and the Fish Audio key are set here too (botToken, fishKey)." : ""),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["show", "change"] },
        piece: { type: "string", description: "With show: the id of one prompt piece whose text to read." },
        change: {
          type: "object",
          description: telegram
            ? "With change: { companion?: <settings patch>, telegram?: <Telegram settings patch>, botToken?: string, " +
              "fishKey?: string|null, pairing?: \"pair\"|\"unpair\", piece?: { id, text } (empty text goes back to the default), personaReview?: true }."
            : "With change: { companion?: <settings patch>, piece?: { id, text } (empty text goes back to the default), personaReview?: true }.",
        },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const answer = await sessionLink.companionSettings({ sessionId, action: params.action, piece: params.piece, change: params.change });
      return { content: [text(JSON.stringify(answer, null, 2))], details: answer };
    },
  });
}

export default createCompanionMessengerFactories;
