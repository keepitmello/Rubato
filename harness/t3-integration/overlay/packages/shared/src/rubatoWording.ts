// Rubato's Korean wording over T3's own Korean catalog, for the desktop's web app and the phone
// (apps/web/src/i18n/rubatoWording.ts and apps/mobile/src/i18n/I18nProvider.tsx load it).
//
// T3 keys a catalog by a hash of the English source, and its en.json maps each
// hash back to that source. Rubato's dictionary (rubatoI18n.ko.json) is keyed
// by the English a person sees on the page. So each hash's source is turned
// into the text it shows ({0} for a value, <0/> for a child element), looked up
// in the dictionary, and Rubato's Korean replaces T3's under the same hash.
// Nothing here names a hash: after a T3 update, whatever English still reads
// the same keeps Rubato's wording, and the rest takes T3's own Korean.

/** Rubato's Korean dictionary (rubatoI18n.ko.json, built by harness/t3-integration/i18n/). */
export interface UiDictionary {
  /** English text (whitespace collapsed) → Korean. */
  readonly exact: Readonly<Record<string, string>>;
  /** [English pattern, Korean pattern]; {n} is a runtime value, <n/> a child element. */
  readonly templates: ReadonlyArray<readonly [string, string]>;
}

export type Catalog = Readonly<Record<string, unknown>>;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const SIMPLE_ARGUMENT = /^\s*([A-Za-z_]\w*)\s*$/;
const SYNTAX = "{}#|";

export interface SourceText {
  /** The text as the page shows it, {n} for the nth value. */
  readonly key: string;
  /** The source's own name of each value, in order. */
  readonly names: ReadonlyArray<string>;
}

/**
 * An ICU source as the page shows it. Select and formatted values have no
 * single English text, so they give null and keep T3's Korean.
 */
export function sourceText(source: string): SourceText | null {
  let text = "";
  const names: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "'") {
      if (source[index + 1] === "'") {
        text += "'";
        index += 2;
        continue;
      }
      if (index + 1 < source.length && SYNTAX.includes(source[index + 1]!)) {
        // A quoted run is literal up to the next lone apostrophe.
        let end = index + 1;
        while (end < source.length) {
          if (source[end] === "'") {
            if (source[end + 1] === "'") {
              text += "'";
              end += 2;
              continue;
            }
            break;
          }
          text += source[end];
          end++;
        }
        index = end + 1;
        continue;
      }
      text += "'";
      index++;
      continue;
    }
    if (char === "{") {
      const close = source.indexOf("}", index);
      const name = close < 0 ? null : SIMPLE_ARGUMENT.exec(source.slice(index + 1, close));
      if (name) {
        text += `{${names.length}}`;
        names.push(name[1]!);
        index = close + 1;
        continue;
      }
      // Korean has one plural form, so a plural reads as its `other` branch.
      const plural = pluralOther(source, index);
      if (!plural) return null;
      const inner = sourceText(plural.other.replaceAll("#", `{${plural.name}}`));
      if (!inner) return null;
      text += inner.key.replace(/\{(\d+)\}/g, (_whole, at: string) => `{${names.length + Number(at)}}`);
      names.push(...inner.names);
      index = plural.end;
      continue;
    }
    if (char === "}") return null;
    text += char;
    index++;
  }
  return { key: normalize(text), names };
}

/**
 * `{name, plural, one {…} other {…}}` at `start`: its `other` branch and where it ends.
 * Null for anything else, and for a plural with exact branches (=0), which say something
 * of their own ("No files").
 */
function pluralOther(
  source: string,
  start: number,
): { readonly name: string; readonly other: string; readonly end: number } | null {
  const head = /^\{\s*([A-Za-z_]\w*)\s*,\s*plural\s*,/.exec(source.slice(start));
  if (!head) return null;
  const branches = new Map<string, string>();
  let index = start + head[0].length;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index++;
    if (source[index] === "}") return branches.has("other") && ![...branches.keys()].some((key) => key.startsWith("="))
      ? { name: head[1]!, other: branches.get("other")!, end: index + 1 }
      : null;
    const selector = /^(=?\w+)\s*\{/.exec(source.slice(index));
    if (!selector) return null;
    let depth = 1;
    let end = index + selector[0].length;
    const bodyStart = end;
    while (end < source.length && depth > 0) {
      if (source[end] === "'" && source[end + 1] === "'") end++;
      else if (source[end] === "{") depth++;
      else if (source[end] === "}") depth--;
      end++;
    }
    if (depth !== 0) return null;
    branches.set(selector[1]!, source.slice(bodyStart, end - 1));
    index = end;
  }
  return null;
}

interface Wording {
  readonly exact: ReadonlyMap<string, string>;
  /** English with {n}/<n/> numbered in reading order → Korean numbered the same way. */
  readonly templates: ReadonlyMap<string, string>;
}

const MARK = /\{(\d+)\}|<(\d+)\/>/g;

/** Numbers values and elements by where they stand in the English, so a T3 source can match. */
function inReadingOrder(english: string, korean: string): readonly [string, string] {
  const values: string[] = [];
  const elements: string[] = [];
  const key = english.replace(MARK, (_whole, value: string | undefined, element: string | undefined) => {
    if (value !== undefined) {
      if (!values.includes(value)) values.push(value);
      return `{${values.indexOf(value)}}`;
    }
    if (!elements.includes(element!)) elements.push(element!);
    return `<${elements.indexOf(element!)}/>`;
  });
  const target = korean.replace(MARK, (whole, value: string | undefined, element: string | undefined) => {
    const at = value !== undefined ? values.indexOf(value) : elements.indexOf(element!);
    if (at < 0) return whole;
    return value !== undefined ? `{${at}}` : `<${at}/>`;
  });
  return [normalize(key), target];
}

export function indexWording(dictionary: UiDictionary): Wording {
  const exact = new Map<string, string>();
  for (const [english, korean] of Object.entries(dictionary.exact)) exact.set(normalize(english), korean);
  const templates = new Map<string, string>();
  for (const [english, korean] of dictionary.templates) {
    const [key, target] = inReadingOrder(english, korean);
    if (!templates.has(key)) templates.set(key, target);
  }
  return { exact, templates };
}

/** Korean text as an ICU message: apostrophes doubled, {n} back to the source's names. */
function icuMessage(korean: string, names: ReadonlyArray<string>): string | null {
  let broken = false;
  const message = korean.replace(/'/g, "''").replace(/\{(\d+)\}|[{}]|<\d+\/>/g, (whole, value: string | undefined) => {
    const name = value === undefined ? undefined : names[Number(value)];
    if (name === undefined) broken = true;
    return name === undefined ? whole : `{${name}}`;
  });
  return broken ? null : message;
}

function rubatoMessage(source: string, wording: Wording): string | null {
  const text = sourceText(source);
  if (!text) return null;
  const korean = text.names.length === 0 ? wording.exact.get(text.key) : wording.templates.get(text.key);
  return korean === undefined ? null : icuMessage(korean, text.names);
}

// ── JSX entries (<T>…</T>): a list of text, values ({k}) and elements ({t}) ──

type Part = string | Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const parts = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [value]);

interface JsxText {
  readonly key: string;
  readonly values: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly elements: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

function jsxText(source: unknown): JsxText | null {
  const values: Readonly<Record<string, unknown>>[] = [];
  const elements: Readonly<Record<string, unknown>>[] = [];
  let key = "";
  for (const part of parts(source)) {
    if (typeof part === "string") key += part;
    else if (isRecord(part) && "t" in part) key += `<${elements.push(part) - 1}/>`;
    else if (isRecord(part) && "k" in part) key += `{${values.push(part) - 1}}`;
    else return null;
  }
  return { key: normalize(key), values, elements };
}

/**
 * The dictionary key a catalog source shows as, or null when it has none (plural,
 * select). i18n/extract.mjs uses it to leave T3's catalog text to T3's translators.
 */
export function catalogKey(source: unknown): string | null {
  return typeof source === "string" ? (sourceText(source)?.key ?? null) : (jsxText(source)?.key ?? null);
}

function rubatoJsx(source: unknown, upstream: unknown, wording: Wording): unknown {
  const text = jsxText(source);
  if (!text) return null;
  const { key, values, elements } = text;
  const korean =
    values.length === 0 && elements.length === 0 ? wording.exact.get(key) : wording.templates.get(key);
  if (korean === undefined) return null;
  // An element keeps T3's Korean for what it holds when T3 has one.
  const translated = new Map<unknown, Readonly<Record<string, unknown>>>();
  for (const part of parts(upstream)) if (isRecord(part) && "t" in part) translated.set(part.i, part);
  const result: Part[] = [];
  const pieces = korean.split(/\{(\d+)\}|<(\d+)\/>/);
  for (let index = 0; index < pieces.length; index += 3) {
    if (pieces[index]) result.push(pieces[index]!);
    const value = pieces[index + 1];
    const element = pieces[index + 2];
    if (value !== undefined) {
      const found = values[Number(value)];
      if (!found) return null;
      result.push(found);
    } else if (element !== undefined) {
      const found = elements[Number(element)];
      if (!found) return null;
      result.push(translated.get(found.i) ?? found);
    }
  }
  return result.length === 1 && typeof result[0] === "string" ? result[0] : result;
}

// ── GitHub's term in T3's provider-switched sentences ──
//
// T3 words one sentence for GitHub, GitLab and others with
// `{term, select, mr {병합 요청} cr {변경 요청} other {풀 리퀘스트}}`. Rubato's glossary
// keeps GitHub's term as "PR", so every branch other than mr (GitLab) and cr reads
// "PR". Only selects that have an mr branch are provider switches.

const PR_TERM: ReadonlyArray<readonly [RegExp, string]> = [
  // "PR" ends in a consonant (피알), so the particle after it changes form.
  [/(?:풀 리퀘스트|PR)를/g, "PR을"],
  [/(?:풀 리퀘스트|PR)가/g, "PR이"],
  [/(?:풀 리퀘스트|PR)는/g, "PR은"],
  [/(?:풀 리퀘스트|PR)와/g, "PR과"],
  [/풀 리퀘스트/g, "PR"],
];

const SELECT_HEAD = /\{\s*[A-Za-z_]\w*\s*,\s*select\s*,/g;

/** One ICU message with GitHub's branch of every provider switch reading "PR". */
export function withGitHubPrTerm(message: string): string {
  let result = "";
  let copied = 0;
  const heads = new RegExp(SELECT_HEAD.source, "g");
  for (let head = heads.exec(message); head; head = heads.exec(message)) {
    const branches: { key: string; start: number; end: number }[] = [];
    let index = head.index + head[0].length;
    let closed = false;
    while (index < message.length) {
      while (/\s/.test(message[index] ?? "")) index++;
      if (message[index] === "}") {
        closed = true;
        break;
      }
      const selector = /^(\w+)\s*\{/.exec(message.slice(index));
      if (!selector) break;
      let depth = 1;
      let end = index + selector[0].length;
      const start = end;
      while (end < message.length && depth > 0) {
        if (message[end] === "{") depth++;
        else if (message[end] === "}") depth--;
        end++;
      }
      if (depth !== 0) break;
      branches.push({ key: selector[1]!, start, end: end - 1 });
      index = end;
    }
    if (!closed || !branches.some((branch) => branch.key === "mr")) continue;
    for (const branch of branches) {
      if (branch.key === "mr" || branch.key === "cr") continue;
      const body = message.slice(branch.start, branch.end);
      result += message.slice(copied, branch.start) + PR_TERM.reduce((text, [pattern, to]) => text.replace(pattern, to), body);
      copied = branch.end;
    }
    heads.lastIndex = index + 1;
  }
  return copied === 0 ? message : result + message.slice(copied);
}

function prTermEntry(value: unknown): unknown {
  if (typeof value === "string") return withGitHubPrTerm(value);
  if (Array.isArray(value)) return value.map((part) => (typeof part === "string" ? withGitHubPrTerm(part) : part));
  return value;
}

/**
 * T3's Korean catalog with Rubato's wording wherever the dictionary has the same English,
 * and GitHub's term in provider-switched sentences as "PR".
 */
export function withRubatoWording(upstream: Catalog, english: Catalog, dictionary: UiDictionary): Catalog {
  const wording = indexWording(dictionary);
  const merged: Record<string, unknown> = { ...upstream };
  for (const [hash, source] of Object.entries(english)) {
    const korean =
      typeof source === "string" ? rubatoMessage(source, wording) : rubatoJsx(source, upstream[hash], wording);
    if (korean !== null) merged[hash] = korean;
  }
  for (const [hash, value] of Object.entries(merged)) merged[hash] = prTermEntry(value);
  return merged;
}
