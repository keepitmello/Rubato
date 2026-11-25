import type { XmlAST } from "react-native-svg";

// The phone's half of a ```svg fence drawn as a picture (reply-visuals-edits.mjs). md4c hands the
// renderer only the fence's first word, so the caption is read back from the reply's own text.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*svg\b([^\n]*)$/i;
const FENCE_TITLE = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;

/** Each ```svg fence's code (trimmed, as the renderer gets it) and its title="…", in the order written. */
export function svgFenceTitles(markdown: string): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  if (!/svg/i.test(markdown)) return titles;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_OPEN.exec(lines[index]!);
    if (!open) continue;
    const fence = open[1]!;
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    const code: string[] = [];
    let end = index + 1;
    while (end < lines.length && !close.test(lines[end]!)) code.push(lines[end++]!);
    const match = FENCE_TITLE.exec(open[2] ?? "");
    const title = match?.[1] ?? match?.[2] ?? match?.[3];
    if (title) titles.set(code.join("\n").trim(), title);
    index = end;
  }
  return titles;
}

const DROPPED_TAGS = new Set(["script", "style", "a", "image", "foreignObject", "iframe"]);
const LOCAL_REFERENCE = /^\s*#/;
const URL_FUNCTION = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

function leavesDocument(value: unknown): boolean {
  if (typeof value !== "string") return false;
  for (const [, , target] of value.matchAll(URL_FUNCTION))
    if (!LOCAL_REFERENCE.test(target ?? "")) return true;
  return false;
}

/**
 * react-native-svg's parse middleware: the tree with nothing that could fetch or open anything (no
 * <image>, <a>, <foreignObject>, <script> or <style>, no href outside the document, no url() that is
 * not a local reference, no event handler). It edits the parsed tree in place before React sees it.
 */
export function safeSvgTree(node: XmlAST): XmlAST {
  for (const [name, value] of Object.entries(node.props ?? {})) {
    const unsafe =
      /^on[A-Z]/.test(name) ||
      ((name === "href" || name === "xlinkHref") && !(typeof value === "string" && LOCAL_REFERENCE.test(value))) ||
      leavesDocument(value) ||
      (value !== null && typeof value === "object" && Object.values(value).some(leavesDocument));
    if (unsafe) delete node.props[name];
  }
  node.children = node.children.filter(
    (child): child is XmlAST | string => typeof child === "string" || !DROPPED_TAGS.has(child.tag),
  );
  for (const child of node.children) if (typeof child !== "string") safeSvgTree(child);
  return node;
}

/** A tone a reply gives a table cell (`<span data-tone="good">`), as the dot the phone shows before it. */
export const RUBATO_TONE_DOTS: Readonly<Record<string, string>> = {
  good: "🟢 ",
  warn: "🟡 ",
  bad: "🔴 ",
};
