// What a reply reads like in each medium, ported from Roo's reply-tool.ts
// (~/.claude/roo-channel/plugins/telegram-daemon/reply-tool.ts): Telegram shows plain text, so
// Markdown emphasis and Fish's voice-control tags are taken out of the text; a voice note hears
// neither emoticons nor Markdown, but keeps the control tags Fish acts on.
//
// Every function here is pure. The service decides which medium a reply goes to.

export function normalizeReplyText(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+/g, '\n\n');
}

/** Telegram does not render Markdown; emphasis asterisks would arrive as noise. */
export function stripMarkdownEmphasis(text) {
  return String(text)
    .replace(/\*\*\*([^\n*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^\n*]+)\*\*/g, '$1')
    .replace(/\*([^\n*]+)\*/g, '$1')
    .replace(/\*\*/g, '');
}

const VOICE_CONTROL_TAG_RE = /\[([A-Za-z][A-Za-z0-9]*(?:[ -][A-Za-z0-9]+)*)\](?!\()/g;
const DECORATIVE_CHARACTER_RE = /[^\p{Script=Hangul}A-Za-z0-9\p{P}\s]/u;
const SPEAKABLE_CHARACTER_RE = /[\p{Script=Hangul}A-Za-z0-9\p{P}\s]/u;
const SEMANTIC_CHARACTER_RE = /[\p{Script=Hangul}A-Za-z0-9]/u;
const VOICE_CONTROL_CUES = new Set([
  'angry', 'anxious', 'break', 'breath', 'breathy', 'calm', 'chuckling',
  'clear throat', 'confident', 'cough', 'disappointed', 'disdainful', 'emphasis',
  'excited', 'gasping', 'gentle', 'groaning', 'guilty', 'happy', 'hysterical',
  'laugh', 'laughing', 'lip-smacking', 'long-break', 'mysterious', 'nervous',
  'panting', 'pause', 'sad', 'screaming', 'shouting', 'sigh', 'sighing',
  'singing', 'snoring', 'sobbing', 'soft', 'softly', 'surprised', 'tone',
  'uncertain', 'voice', 'warm', 'whimpering', 'whisper', 'whispered',
  'whispering', 'whispers', 'yawning',
  'audience laughing', 'background laughter', 'crowd laughing',
  'in a hurry tone', 'laughing nervously', 'soft tone', 'whispers sweetly',
]);

function cleanTagRemovalWhitespace(text) {
  return text.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
}

/** The text medium never shows Fish's emotion and effect tags. */
export function stripVoiceControlTags(text) {
  const source = String(text);
  const stripped = source.replace(VOICE_CONTROL_TAG_RE, (tag, cue) => (VOICE_CONTROL_CUES.has(String(cue).toLowerCase()) ? '' : tag));
  return stripped === source ? source : cleanTagRemovalWhitespace(stripped);
}

function isKaomojiBody(body) {
  const compact = body.replace(/\s+/g, '');
  if (DECORATIVE_CHARACTER_RE.test(body) && !SEMANTIC_CHARACTER_RE.test(body)) return true;
  return /^(?:T+|Q+|ㅠ+|ㅜ+|눈+)(?:[_\-.]?(?:T+|Q+|ㅠ+|ㅜ+|눈+))?$/iu.test(compact);
}

function stripDecorativeGroups(text) {
  const withoutGroups = text.replace(/\(([^()\n]{0,80})\)|（([^（）\n]{0,80})）/gu, (group, asciiBody, wideBody) =>
    (isKaomojiBody(String(asciiBody ?? wideBody ?? '')) ? '' : group));
  return withoutGroups.replace(/\S+/gu, (token) => (DECORATIVE_CHARACTER_RE.test(token) && !SEMANTIC_CHARACTER_RE.test(token) ? '' : token));
}

function stripInlineEmoticons(text) {
  return text
    .replace(/(?<![A-Za-z0-9])(?:[:;=8xX]['^,-]?[)(/\\DPpOo]|<3)(?=$|\s|[.!?,])/gu, '')
    .replace(/(^|\s)(?:T[_\-.]?T|Q[_\-.]?Q|ㅠ{2,}|ㅜ{2,})(?=$|\s|[.!?,])/giu, '$1')
    .replace(/(?:ㅠ{2,}|ㅜ{2,})(?=$|\s|[.!?,])/gu, '');
}

function stripMarkdownLinks(text) {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const image = text[index] === '!' && text[index + 1] === '[';
    const labelStart = image ? index + 2 : text[index] === '[' ? index + 1 : -1;
    if (labelStart < 0) { output += text[index]; index += 1; continue; }
    let labelEnd = labelStart;
    while (labelEnd < text.length && text[labelEnd] !== ']') {
      if (text[labelEnd] === '\\' && labelEnd + 1 < text.length) labelEnd += 1;
      labelEnd += 1;
    }
    if (labelEnd >= text.length || text[labelEnd + 1] !== '(') { output += text[index]; index += 1; continue; }
    let destinationEnd = labelEnd + 2;
    let depth = 1;
    while (destinationEnd < text.length && depth > 0) {
      const character = text[destinationEnd];
      if (character === '\\' && destinationEnd + 1 < text.length) { destinationEnd += 2; continue; }
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      destinationEnd += 1;
    }
    if (depth !== 0) { output += text[index]; index += 1; continue; }
    output += text.slice(labelStart, labelEnd);
    index = destinationEnd;
  }
  return output;
}

/** What a voice note says: no visual decoration, no Markdown; Fish's `[pause]` and the like stay. */
export function sanitizeVoiceText(text) {
  const withoutBlockMarkdown = stripMarkdownLinks(String(text))
    .replace(/^\s{0,3}#{1,6}(?=\s|$)\s*/gm, '')
    .replace(/^\s{0,3}(?:[-+*•]\s+|\d+[.)]\s+|>\s*)/gm, '')
    .replace(/^\s*\[[ xX]\]\s*/gm, '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`\n]+)`/g, '$1');
  const withoutMarkdown = stripInlineEmoticons(stripDecorativeGroups(withoutBlockMarkdown));
  const withoutInlineMarkdown = stripMarkdownEmphasis(withoutMarkdown).replace(/[*_~]/g, '');
  let speakable = '';
  for (const character of withoutInlineMarkdown) if (SPEAKABLE_CHARACTER_RE.test(character)) speakable += character;
  return speakable.replace(/\s+/g, ' ').trim();
}

/** The plain text Telegram shows for words Segno wrote anywhere (an answer, a tool message). */
export function telegramText(text) {
  return stripMarkdownEmphasis(normalizeReplyText(telegramMarkup(stripVoiceControlTags(String(text)))));
}

const TONE_DOTS = { good: '🟢', warn: '🟡', bad: '🔴' };
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * A Markdown table as Telegram can read it: one line per row, its first cell, then each other
 * cell under its column's name. `| 무게 | 60g | 🟢 매우 큼 |` under `항목 | 값 | 차이` reads
 * `• 무게 — 값 60g · 차이 🟢 매우 큼`.
 */
function tableLines(lines) {
  const header = tableCells(lines[0]);
  return lines.slice(2).map((line) => {
    const cells = tableCells(line);
    const rest = cells.slice(1).map((cell, index) => (header[index + 1] ? `${header[index + 1]} ${cell}` : cell)).filter((part) => part.trim());
    return `• ${cells[0]}${rest.length ? ` — ${rest.join(' · ')}` : ''}`;
  });
}

/**
 * What the app draws and Telegram cannot (reply-visuals-edits.mjs), as words: a toned cell's
 * colour as its dot, <details> open with its <summary> as a line, a table row by row. Code
 * blocks keep their text as written.
 */
export function telegramMarkup(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker; out.push(line); continue; }
    if (line.includes('|') && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      let end = index + 2;
      while (end < lines.length && lines[end].includes('|') && lines[end].trim()) end += 1;
      out.push(...tableLines(lines.slice(index, end).map(inlineMarkup)));
      index = end - 1;
      continue;
    }
    out.push(inlineMarkup(line));
  }
  return out.join('\n');
}

function inlineMarkup(line) {
  return line
    .replace(/<span\b[^>]*\bdata-tone\s*=\s*["']?(good|warn|bad)["']?[^>]*>/gi, (_tag, tone) => `${TONE_DOTS[tone.toLowerCase()]} `)
    .replace(/<summary\b[^>]*>/gi, '▸ ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:span|details|summary|sub|sup|kbd|ins|del|b|i|strong|em|p|div)\b[^>]*>/gi, '');
}

/**
 * Which media one reply goes out in and what each says (Roo's prepareReplyPayload): `text` only,
 * text and a voice note (`voice: true`), or a voice note only (`voice: 'only'`). Given one of
 * `text` and `voiceText`, both media read from it.
 */
export function prepareReplyPayload({ text, voiceText, voice, sanitize } = {}) {
  if (voice !== undefined && voice !== false && voice !== true && voice !== 'only') throw new Error('voice must be true, false or "only"');
  if (sanitize !== undefined && typeof sanitize !== 'boolean') throw new Error('sanitize must be true or false');
  const given = (value) => typeof value === 'string' && value.trim() !== '';
  if (text !== undefined && !given(text)) throw new Error('text must be a non-empty string');
  if (voiceText !== undefined && !given(voiceText)) throw new Error('voice_text must be a non-empty string');
  if (text === undefined && voiceText === undefined) throw new Error('a reply needs text or voice_text');
  const delivery = voice === 'only' ? 'voice' : voice === true ? 'text-and-voice' : 'text';
  const clean = sanitize !== false;
  const prepared = { delivery };
  if (delivery !== 'voice') {
    const finalText = clean ? telegramText(text ?? voiceText) : String(text ?? voiceText);
    if (!finalText.trim()) throw new Error('the text is empty after sanitizing; pass sanitize=false to keep it');
    prepared.text = finalText;
  }
  if (delivery !== 'text') {
    const finalVoice = clean ? sanitizeVoiceText(voiceText ?? text) : String(voiceText ?? text);
    if (!finalVoice.trim()) throw new Error('the voice text is empty after sanitizing; pass sanitize=false to keep it');
    prepared.voiceText = finalVoice;
  }
  return prepared;
}
