import type { Nodes } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

// CommonMark alone: no strikethrough, so every lone ~ the reply wrote is still in a text node,
// and code, code spans and HTML keep theirs.
const parser = unified().use(remarkParse);

const URL_TOKEN = /^[(<["']*(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;

/** Whether offset sits in a whitespace-delimited token that reads as a URL or an email address. */
function inUrlToken(markdown: string, offset: number): boolean {
  let start = offset;
  while (start > 0 && !/\s/.test(markdown[start - 1]!)) start--;
  let end = offset;
  while (end < markdown.length && !/\s/.test(markdown[end]!)) end++;
  const token = markdown.slice(start, end);
  return URL_TOKEN.test(token) || /^[^@]+@[^@]+\.[a-z]{2,}/i.test(token);
}

/**
 * Escapes every lone ~ in prose so md4c's GitHub flavor, which strikes `~text~`, leaves it a
 * tilde. `~~double~~` still strikes, as on the Mac (remark-gfm `singleTilde: false`).
 */
export function markdownWithLiteralSingleTildes(markdown: string): string {
  if (!markdown.includes("~")) return markdown;
  const offsets: number[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (let index = start; index < end; index++) {
        if (markdown[index] !== "~") continue;
        if (markdown[index - 1] === "~" || markdown[index + 1] === "~") continue;
        if (markdown[index - 1] === "\\") continue;
        if (inUrlToken(markdown, index)) continue;
        offsets.push(index);
      }
      return;
    }
    // <https://host/~user> is an autolink; its text is the URL itself.
    if (node.type === "link" && markdown[node.position?.start.offset ?? -1] === "<") return;
    if ("children" in node) for (const child of node.children) visit(child as Nodes);
  };
  visit(parser.parse(markdown));
  if (offsets.length === 0) return markdown;
  offsets.sort((left, right) => left - right);
  const parts: string[] = [];
  let from = 0;
  for (const offset of offsets) {
    parts.push(markdown.slice(from, offset), "\\");
    from = offset;
  }
  parts.push(markdown.slice(from));
  return parts.join("");
}
