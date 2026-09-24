// 제목은 짧은 문장 하나라 값싼 모델이면 충분하다. 앞에서부터 인증이 서 있는
// 후보를 쓰고, 다 없으면 세션 모델로 떨어진다. CLI 탭 제목과 앱 스레드 제목이
// 같은 값을 쓰므로 이 사슬 하나가 정본이다.
export const TITLE_MODELS = Object.freeze([
  Object.freeze({ provider: "b-ai", id: "deepseek-v4.1-flash", reasoning: "low" }),
  Object.freeze({ provider: "openai-codex", id: "gpt-6-luna" }),
]);
export const TITLE_ENTRY = "rubato-pi.session-title";

export const TITLE_SYSTEM_PROMPT = `Name this coding-agent session.

Rules:
- Title the current topic, not the opening message if they differ.
- Use at most 3 words, and prefer 2.
- Prefer concrete nouns and verbs from the work.
- Drop articles, filler, and any word the title still reads fine without.
- Do not include quotes, trailing punctuation, markdown, or explanations.
- If the input is only a greeting or too vague to title, return <title>none</title>.
- Respond only as <title>Session Title</title>.`;

export function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text ?? "";
      return "";
    })
    .join("");
}

export function userTextsFromEntries(entries, { limit = 6, maxChars = 400 } = {}) {
  const texts = [];
  for (const entry of entries ?? []) {
    const message = entry?.type === "message" ? entry.message : entry;
    if (message?.role !== "user") continue;
    const text = textOfContent(message.content).replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("/")) continue;
    texts.push(text.length > maxChars ? `${text.slice(0, maxChars).trim()}…` : text);
  }
  return texts.slice(-limit);
}

export function buildTitlePrompt(texts) {
  const lines = texts.map((text, index) => `${index + 1}. ${text}`);
  return `Recent user messages:\n${lines.join("\n")}`;
}

export function sanitizeTitle(text) {
  return String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`.!?]+$/g, "")
    .trim()
    .slice(0, 32)
    .trim();
}

export function parseTitle(raw) {
  const text = typeof raw === "string" ? raw : textOfContent(raw);
  const match = text.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
  if (!match) return undefined;
  const title = sanitizeTitle(match[1]);
  if (!title || title.toLowerCase() === "none") return undefined;
  return title;
}

function titleEntries(entries) {
  return (entries ?? []).filter((entry) => entry?.type === "custom" && entry.customType === TITLE_ENTRY);
}

export function lastAutoTitle(entries) {
  for (const entry of titleEntries(entries).reverse()) {
    if (entry.data?.locked) continue;
    const name = typeof entry.data?.name === "string" ? entry.data.name.trim() : "";
    if (name) return name;
  }
  return undefined;
}

export function isTitleLocked(entries) {
  const last = titleEntries(entries).at(-1);
  return Boolean(last?.data?.locked);
}

export function shouldRetitle({ current, proposed, locked } = {}) {
  if (locked) return false;
  if (!proposed) return false;
  return proposed !== current;
}

export function tabTitle(name, cwdBasename) {
  const explicit = String(name ?? "").trim();
  const folder = String(cwdBasename ?? "").trim();
  return explicit || folder || "";
}
