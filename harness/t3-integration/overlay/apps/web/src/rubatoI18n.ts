// Korean interface (Settings > Appearance > Interface > Language).
//
// T3's components carry English literals and T3 does not take localization
// upstream, so the components stay as they are and the text React writes into
// the page is swapped from a dictionary (rubatoI18n.ko.json, built by
// harness/t3-integration/i18n/ in the Rubato checkout). A MutationObserver sees
// each text node and attribute React writes and replaces it before the browser
// paints. React keeps what it last wrote in its own memory and never reads the
// page back, so a swapped node stays swapped until React writes that node again;
// the observer then sees the new English and swaps it too.
//
// The unit is an element's own text: its text children joined, with each child
// element written as <n/>, so "Choose which <code>gh</code> login" is one entry
// that keeps the code where Korean word order wants it. Entries with {0}, {1}
// are templates for text with runtime values. What a person or a model wrote
// (messages, code, the composer, terminals) is never touched.

export type UiLanguage = "en" | "ko";

export interface UiDictionary {
  /** English text (whitespace collapsed) → Korean. */
  readonly exact: Readonly<Record<string, string>>;
  /** [English pattern, Korean pattern]; {n} is a runtime value, <n/> a child element. */
  readonly templates: ReadonlyArray<readonly [string, string]>;
}

export const UI_LANGUAGE_STORAGE_KEY = "rubato:ui-language";

/** Attributes that show text: tooltips, placeholders and what a screen reader says. */
export const TRANSLATED_ATTRIBUTES = ["title", "placeholder", "aria-label", "aria-description", "alt"] as const;

/** Where text belongs to a person, a model or a program, not to the interface. */
export const UNTRANSLATED_SELECTOR = [
  '[translate="no"]',
  ".notranslate",
  "pre",
  "code",
  "kbd",
  "textarea",
  "script",
  "style",
  "[contenteditable]:not([contenteditable='false'])",
  ".xterm",
  ".chat-markdown",
  ".composer-tiptap",
  "[data-user-message-collapsed]",
].join(", ");

export function normalizeUiText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const PLACEHOLDER = /\{(\d+)\}/g;
const MARKER = /<(\d+)\/>/g;

interface CompiledTemplate {
  readonly pattern: RegExp;
  /** The same with the first value greedy, for "{0}: {1}" where the value itself has a colon. */
  readonly greedy: RegExp | null;
  /** Placeholder number of each capture group, in order. */
  readonly slots: ReadonlyArray<number>;
  readonly korean: string;
  /** Letters of its own, outside values. */
  readonly specificity: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTemplate(english: string, korean: string): CompiledTemplate | null {
  const literal = english.replace(PLACEHOLDER, "").replace(MARKER, "");
  // "{0} {1}" or "{0}s" would match any text.
  if ((literal.match(/\p{L}/gu) ?? []).length < 3) return null;
  const slots: number[] = [];
  let source = "";
  let greedy = "";
  let last = 0;
  for (const match of english.matchAll(PLACEHOLDER)) {
    const literalPart = escapeRegExp(english.slice(last, match.index));
    source += literalPart + "(.*?)";
    greedy += literalPart + (slots.length === 0 ? "(.*)" : "(.*?)");
    slots.push(Number(match[1]));
    last = match.index + match[0].length;
  }
  source += escapeRegExp(english.slice(last));
  greedy += escapeRegExp(english.slice(last));
  return {
    pattern: new RegExp(`^${source}$`, "su"),
    greedy: slots.length > 1 ? new RegExp(`^${greedy}$`, "su") : null,
    slots,
    korean,
    specificity: (literal.match(/\p{L}/gu) ?? []).length,
  };
}

const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length;

/**
 * Whether a template match reads as the template's own sentence with values
 * filled in. "{0} for {1}" also matches any English sentence with "for" in it;
 * there the values carry most of the words, and each holds a phrase. A value
 * is a name, a number, a few words or interface text, so a match whose values are other phrases
 * and whose own words are under a third of the text is not this template.
 */
function plausible(
  key: string,
  match: RegExpExecArray,
  known: (value: string) => boolean,
): boolean {
  const values = match.slice(1);
  // A phrase that is itself interface text ("Edit shortcut for Thread: Pin") is a value.
  const phrase = values.some((value) => value.trim().split(/\s+/).length >= 3 && !known(value));
  if (!phrase) return true;
  const own = letters(key) - values.reduce((sum, value) => sum + letters(value), 0);
  return own / Math.max(1, letters(key)) >= 1 / 3;
}

export interface UiTranslator {
  /** Korean for an English key (normalized), or null when the dictionary has none. */
  lookup(key: string): string | null;
}

export function createUiTranslator(dictionary: UiDictionary): UiTranslator {
  const exact = new Map<string, string>();
  for (const [english, korean] of Object.entries(dictionary.exact)) {
    exact.set(normalizeUiText(english), korean);
  }
  // Templates are indexed by the first two characters of their literal start,
  // or failing that the last two of their literal end, so a lookup tries a few
  // dozen patterns, not all of them.
  const byStart = new Map<string, CompiledTemplate[]>();
  const byEnd = new Map<string, CompiledTemplate[]>();
  const loose: CompiledTemplate[] = [];
  const file = (index: Map<string, CompiledTemplate[]>, key: string, template: CompiledTemplate) => {
    const list = index.get(key);
    if (list) list.push(template);
    else index.set(key, [template]);
  };
  for (const [rawEnglish, korean] of dictionary.templates) {
    const english = normalizeUiText(rawEnglish);
    const template = compileTemplate(english, korean);
    if (!template) continue;
    const start = english.split("{")[0] ?? "";
    const end = english.slice(english.lastIndexOf("}") + 1);
    if (start.length >= 2) file(byStart, start.slice(0, 2), template);
    else if (end.length >= 2) file(byEnd, end.slice(-2), template);
    else loose.push(template);
  }
  // The template with the most text of its own is the most specific reading:
  // "Update Available: {0} {1}" before "Update {0}".
  for (const list of [...byStart.values(), ...byEnd.values(), loose]) {
    list.sort((a, b) => b.specificity - a.specificity);
  }

  function matchTemplates(key: string, candidates: ReadonlyArray<CompiledTemplate> | undefined) {
    if (!candidates) return null;
    const known = (value: string) => exact.has(normalizeUiText(value));
    for (const template of candidates) {
      // The shortest first value or the longest: whichever reads as the
      // template, preferring the split whose values are interface text.
      const readings = [template.pattern, template.greedy]
        .map((pattern) => pattern?.exec(key) ?? null)
        .filter((found): found is RegExpExecArray => found !== null && plausible(key, found, known));
      const score = (found: RegExpExecArray) => found.slice(1).filter(known).length;
      const match = readings.reduce<RegExpExecArray | null>(
        (best, found) => (best === null || score(found) > score(best) ? found : best),
        null,
      );
      if (!match) continue;
      return template.korean.replace(PLACEHOLDER, (whole, number: string) => {
        const at = template.slots.indexOf(Number(number));
        if (at < 0) return whole;
        const value = match[at + 1] ?? "";
        // A value that is itself interface text ("files", "Not installed")
        // reads in Korean too; anything else (names, numbers) stays.
        return exact.get(normalizeUiText(value)) ?? value;
      });
    }
    return null;
  }

  return {
    lookup(key) {
      if (key.length === 0 || !/\p{L}/u.test(key)) return null;
      const found = exact.get(key);
      if (found !== undefined) return found;
      return (
        matchTemplates(key, byStart.get(key.slice(0, 2))) ??
        matchTemplates(key, byEnd.get(key.slice(-2))) ??
        matchTemplates(key, loose)
      );
    },
  };
}

// ── The page ─────────────────────────────────────────────────────────

interface Swap {
  readonly original: string;
  readonly applied: string;
}

export interface PageTranslation {
  /** Translates everything under root now and keeps translating what changes. */
  start(): void;
  /** Stops and puts the English back. */
  stop(): void;
  /** Korean for a string, or the string itself. */
  text(value: string): string;
}

export function createPageTranslation(
  root: Element,
  translator: UiTranslator,
  /** Hears interface text the dictionary has no entry for (rubato:i18n-collect). */
  missing?: (text: string) => void,
): PageTranslation {
  const textSwaps = new WeakMap<Text, Swap>();
  const attributeSwaps = new WeakMap<Element, Map<string, Swap>>();
  let observer: MutationObserver | null = null;

  /** What React last wrote into the node: ours if the node still shows our text. */
  function originalText(node: Text): string {
    const swap = textSwaps.get(node);
    if (swap && node.data === swap.applied) return swap.original;
    if (swap) textSwaps.delete(node);
    return node.data;
  }

  function writeText(node: Text, original: string, value: string) {
    if (node.data !== value) node.data = value;
    if (value === original) textSwaps.delete(node);
    else textSwaps.set(node, { original, applied: value });
  }

  const untranslated = (element: Element) => element.closest(UNTRANSLATED_SELECTOR) !== null;

  function translateAttribute(element: Element, name: string) {
    const current = element.getAttribute(name);
    const swaps = attributeSwaps.get(element);
    const swap = swaps?.get(name);
    if (current === null) {
      swaps?.delete(name);
      return;
    }
    const original = swap && current === swap.applied ? swap.original : current;
    const korean = translator.lookup(normalizeUiText(original));
    if (korean === null) missing?.(original);
    const value = korean ?? original;
    if (current !== value) element.setAttribute(name, value);
    if (value === original) {
      swaps?.delete(name);
    } else {
      const map = swaps ?? new Map<string, Swap>();
      map.set(name, { original, applied: value });
      if (!swaps) attributeSwaps.set(element, map);
    }
  }

  /** Puts the whole entry in the first text node of each run and empties the rest. */
  function fillRun(run: ReadonlyArray<Text>, originals: ReadonlyArray<string>, value: string) {
    run.forEach((node, index) => writeText(node, originals[index]!, index === 0 ? value : ""));
  }

  function translateRun(run: ReadonlyArray<Text>) {
    const originals = run.map(originalText);
    const korean = translator.lookup(normalizeUiText(originals.join("")));
    if (korean !== null) {
      fillRun(run, originals, keepEdges(originals.join(""), korean));
      return;
    }
    // The run as a whole is not an entry: try each node on its own.
    run.forEach((node, index) => {
      const original = originals[index]!;
      const own = translator.lookup(normalizeUiText(original));
      if (own === null) missing?.(original);
      writeText(node, original, own === null ? original : keepEdges(original, own));
    });
  }

  function translateElement(element: Element) {
    const runs: Text[][] = [[]];
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        runs[runs.length - 1]!.push(child as Text);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        runs.push([]);
      }
    }
    const filled = runs.filter((run) => run.some((node) => originalText(node).trim().length > 0));
    if (!filled.some((run) => run.some((node) => /\p{L}/u.test(originalText(node))))) return;
    // An icon beside a label is still one entry ("Cancel"); child elements are
    // marked only when text sits on both sides of one ("Run <0/>.").
    if (filled.length > 1) {
      // Blank runs at either end (around a leading icon, say) are not part of the entry.
      const blank = (run: Text[]) => run.every((node) => originalText(node).trim().length === 0);
      let first = 0;
      let last = runs.length - 1;
      while (blank(runs[first]!)) first++;
      while (blank(runs[last]!)) last--;
      const kept = runs.slice(first, last + 1);
      const originals = kept.map((run) => run.map(originalText));
      const key = normalizeUiText(
        originals.map((run, index) => (index === 0 ? "" : `<${index - 1}/>`) + run.join("")).join(""),
      );
      const korean = translator.lookup(key);
      if (korean !== null && placeWithElements(kept, originals, korean)) return;
      if (korean === null) missing?.(key);
      // Otherwise each run on its own: a value ("Not installed") may be an
      // entry, and this also puts back English a changed sentence left behind.
    }
    for (const run of runs) if (run.length > 0) translateRun(run);
  }

  /**
   * Writes a Korean entry with <n/> markers around the element's children,
   * which stay where React put them. Korean that needs the children in another
   * order, or text where no text node exists, cannot be placed.
   */
  function placeWithElements(runs: Text[][], originals: string[][], korean: string): boolean {
    const parts = korean.split(/<(\d+)\/>/);
    const segments: string[] = [];
    for (let index = 0; index < parts.length; index += 2) {
      if (index > 0 && Number(parts[index - 1]) !== segments.length - 1) return false;
      segments.push(parts[index]!);
    }
    if (segments.length !== runs.length) return false;
    segments[0] = segments[0]!.trimStart();
    segments[segments.length - 1] = segments[segments.length - 1]!.trimEnd();
    for (let index = 0; index < runs.length; index++) {
      if (runs[index]!.length === 0 && segments[index]!.trim().length > 0) return false;
    }
    runs.forEach((run, index) => {
      if (run.length > 0) fillRun(run, originals[index]!, segments[index]!);
    });
    return true;
  }

  function translateTree(top: Element) {
    if (untranslated(top)) return;
    const visit = (element: Element) => {
      for (const name of TRANSLATED_ATTRIBUTES) {
        if (element.hasAttribute(name)) translateAttribute(element, name);
      }
      translateElement(element);
    };
    visit(top);
    for (const element of top.querySelectorAll("*")) {
      if (!untranslated(element)) visit(element);
    }
  }

  function onMutations(records: ReadonlyArray<MutationRecord>) {
    const elements = new Set<Element>();
    const trees = new Set<Element>();
    for (const record of records) {
      if (record.type === "attributes") {
        const element = record.target as Element;
        if (record.attributeName && !untranslated(element)) translateAttribute(element, record.attributeName);
      } else if (record.type === "characterData") {
        const parent = record.target.parentElement;
        if (parent) elements.add(parent);
      } else {
        if (record.target.nodeType === Node.ELEMENT_NODE) elements.add(record.target as Element);
        for (const added of record.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE) trees.add(added as Element);
        }
      }
    }
    for (const tree of trees) if (tree.isConnected) translateTree(tree);
    for (const element of elements) {
      if (element.isConnected && !untranslated(element)) translateElement(element);
    }
    // Our own writes queue records too; they need no answer.
    observer?.takeRecords();
  }

  function restore() {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const swap = textSwaps.get(text);
      if (swap && text.data === swap.applied) text.data = swap.original;
      textSwaps.delete(text);
    }
    for (const element of [root, ...root.querySelectorAll("*")]) {
      const swaps = attributeSwaps.get(element);
      if (!swaps) continue;
      for (const [name, swap] of swaps) {
        if (element.getAttribute(name) === swap.applied) element.setAttribute(name, swap.original);
      }
      attributeSwaps.delete(element);
    }
  }

  return {
    start() {
      if (observer) return;
      observer = new MutationObserver(onMutations);
      translateTree(root);
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...TRANSLATED_ATTRIBUTES],
      });
    },
    stop() {
      observer?.disconnect();
      observer = null;
      restore();
    },
    text(value) {
      const korean = translator.lookup(normalizeUiText(value));
      return korean === null ? value : keepEdges(value, korean);
    },
  };
}

/** A text node's own leading and trailing space separate it from its neighbours. */
function keepEdges(original: string, korean: string): string {
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  return lead + korean.trim() + (trail === original ? "" : trail);
}

// ── The app ──────────────────────────────────────────────────────────

let active: PageTranslation | null = null;
let current: UiLanguage = "en";
let dictionary: Promise<UiDictionary> | null = null;
const listeners = new Set<() => void>();

function loadKorean(): Promise<UiDictionary> {
  dictionary ??= import("./rubatoI18n.ko.json").then((module) => module.default as unknown as UiDictionary);
  return dictionary;
}

/**
 * With localStorage "rubato:i18n-collect" set to "1", English the dictionary
 * lacks gathers in window.__rubatoI18nMissing, for i18n/README.md's gap pass.
 */
function missingCollector(): ((text: string) => void) | undefined {
  try {
    if (window.localStorage.getItem("rubato:i18n-collect") !== "1") return undefined;
  } catch {
    return undefined;
  }
  const seen = new Set<string>();
  (window as { __rubatoI18nMissing?: Set<string> }).__rubatoI18nMissing = seen;
  return (text) => {
    const key = normalizeUiText(text);
    if (/\p{L}{2}/u.test(key) && seen.size < 20_000) seen.add(key);
  };
}

function storedLanguage(): UiLanguage {
  try {
    return window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY) === "ko" ? "ko" : "en";
  } catch {
    return "en";
  }
}

export function uiLanguage(): UiLanguage {
  return current;
}

export function subscribeUiLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The interface text for a string in the current language. */
export function uiText(value: string): string {
  return active ? active.text(value) : value;
}

/**
 * Switches the page now and remembers the choice for the next start, before
 * settings load. A failed dictionary load leaves the page in English.
 */
export async function setUiLanguage(language: UiLanguage): Promise<void> {
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Private windows refuse storage; the setting still holds for this run.
  }
  if (language === current) return;
  current = language;
  if (language === "ko") {
    const translator = createUiTranslator(await loadKorean());
    if (current !== "ko") return;
    active?.stop();
    active = createPageTranslation(document.body, translator, missingCollector());
    active.start();
    document.documentElement.lang = "ko";
  } else {
    active?.stop();
    active = null;
    document.documentElement.lang = "en";
  }
  for (const listener of listeners) listener();
}

/** Runs before the first render, so a Korean start never shows English first. */
export function startUiLanguage(): Promise<void> {
  if (storedLanguage() !== "ko") return Promise.resolve();
  return setUiLanguage("ko").catch(() => undefined);
}
