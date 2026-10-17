import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

// 제목은 짧은 문장 하나라 값싼 모델이면 충분하다. 앞에서부터 인증이 서 있는
// 후보를 쓰고, 다 없으면 세션 모델로 떨어진다. CLI 탭 제목과 앱 스레드 제목,
// Stats 페이지의 "가장 길게 생각한 순간" 카드가 같은 사슬을 쓴다.
// 사용자가 ~/.rubato/rubato.jsonc 의 titles.models 로 바꾸면 그쪽이 이긴다 (loadTitleModels).
export const TITLE_MODELS = Object.freeze([
  Object.freeze({ provider: "opengateway", id: "deepseek/deepseek-v4.1-flash-ultrafast" }),
  Object.freeze({ provider: "anthropic", id: "claude-haiku-4-5", reasoning: "off" }),
]);

/**
 * `titles.models` 의 rung("<provider>/<id>" 또는 {model, reasoning}) → {provider, id, reasoning?}.
 * 프로바이더는 첫 슬래시에서만 가른다 (opengateway 의 id 는 슬래시를 품는다). 잘못된 rung 과 중복은 버린다.
 */
export function titleLadder(models) {
  const ladder = [];
  for (const entry of Array.isArray(models) ? models : []) {
    const model = typeof entry === "string" ? entry : entry?.model;
    if (typeof model !== "string") continue;
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) continue;
    const rung = { provider: model.slice(0, slash), id: model.slice(slash + 1) };
    if (ladder.some((held) => held.provider === rung.provider && held.id === rung.id)) continue;
    const reasoning = typeof entry === "object" && typeof entry.reasoning === "string" ? entry.reasoning : undefined;
    ladder.push(Object.freeze(reasoning ? { ...rung, reasoning } : rung));
  }
  return Object.freeze(ladder);
}

/** 설정 파일 자리: rubato.jsonc, 그게 없고 rubato.json 만 있으면 그쪽. */
export function titleConfigPath(home = homedir()) {
  const jsonc = join(home, ".rubato", "rubato.jsonc");
  const json = join(home, ".rubato", "rubato.json");
  return !existsSync(jsonc) && existsSync(json) ? json : jsonc;
}

/** 지금 쓰는 사슬: 사용자의 titles.models, 없거나 비었거나 못 읽으면 TITLE_MODELS. */
export function loadTitleModels({ home = process.env.HOME || homedir(), readFile = readFileSync } = {}) {
  try {
    const config = parseJsonc(readFile(titleConfigPath(home), "utf8"), [], { allowTrailingComma: true });
    const ladder = titleLadder(config?.titles?.models);
    if (ladder.length > 0) return ladder;
  } catch {
    // 파일이 없거나 깨졌으면 기본 사슬로 간다. 제목 하나 때문에 세션을 막지 않는다.
  }
  return TITLE_MODELS;
}
export const TITLE_ENTRY = "rubato-pi.session-title";

export const TITLE_SYSTEM_PROMPT = `Name this coding-agent session.

Rules:
- Title what the user is trying to get done across the whole session, not the subject currently being discussed.
- The latest messages are often a step, detour, or example inside that goal. Change the title only when the session has clearly moved on to a different goal.
- If a current title is given and still names the goal, return it unchanged.
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

// 제목은 세션 전체의 목적을 불러야 한다. 최근 메시지만 보이면 곁가지 하나가 제목을
// 차지하므로, 처음·중간·최근을 고르게 뽑아 넘긴다. 번호는 세션 안의 원래 순번이다.
export function userTextsFromEntries(entries, { limit = 12, recent = 4, maxChars = 300 } = {}) {
  const texts = [];
  for (const entry of entries ?? []) {
    const message = entry?.type === "message" ? entry.message : entry;
    if (message?.role !== "user") continue;
    const text = textOfContent(message.content).replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("/")) continue;
    texts.push(text.length > maxChars ? `${text.slice(0, maxChars).trim()}…` : text);
  }
  const all = texts.map((text, index) => ({ n: index + 1, text }));
  if (all.length <= limit) return all;
  const tail = all.slice(-recent);
  const earlier = all.slice(0, -recent);
  const spread = limit - recent;
  const picked = Array.from({ length: spread }, (_, i) => earlier[Math.round((i * (earlier.length - 1)) / (spread - 1))]);
  return [...picked, ...tail];
}

export function buildTitlePrompt(picks, current) {
  const lines = picks.map(({ n, text }) => `${n}. ${text}`);
  const head = current ? `Current title: ${current}\n\n` : "";
  return `${head}User messages sampled across the session, numbered in order:\n${lines.join("\n")}`;
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
