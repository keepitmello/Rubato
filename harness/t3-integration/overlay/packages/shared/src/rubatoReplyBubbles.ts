// One reply, several bubbles (user, 2026-11-22): each paragraph of a companion's reply is its own
// bubble, except what only reads whole (a code block, a spread-out list, a lead-in ending in ':', a
// heading, an indented line, file lines). Telegram breaks by the same rule in harness/companion/home.mjs
// replyBubbles; change both together.

/** At most this many bubbles; what is left joins the last one. */
export const REPLY_BUBBLES_MAX = 8;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s/;
const HEADING = /^#{1,6}\s/;
const INDENTED = /^(?: {2,}|\t)\S/;
const FILE_BLOCK = /^!?\[[^\]\n]*\]\(<\/[^>\n]+>\)$/;

/** The paragraphs of a text, a fenced code block always one of them. */
function paragraphs(text: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence: string | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").trim().split("\n")) {
    if (fence !== null) {
      lines.push(line);
      if (line.trim().startsWith(fence)) fence = null;
    } else if (FENCE.test(line)) {
      fence = line.match(FENCE)![1]!;
      lines.push(line);
    } else if (!line.trim()) {
      if (lines.length > 0) blocks.push(lines.join("\n"));
      lines = [];
    } else lines.push(line);
  }
  if (lines.length > 0) blocks.push(lines.join("\n"));
  return blocks;
}

/** Whether `block` belongs with the bubble that ends in `previous` instead of starting its own. */
function joinsPrevious(previous: string, block: string): boolean {
  const last = previous.split("\n").at(-1)!;
  const first = block.split("\n")[0]!;
  return (
    FILE_BLOCK.test(block.trim()) ||
    (LIST_ITEM.test(last) && LIST_ITEM.test(first)) ||
    INDENTED.test(first) ||
    last.trimEnd().endsWith(":") ||
    (previous.split("\n").length === 1 && HEADING.test(previous))
  );
}

/** The bubbles one reply's text shows as, in order. One paragraph is one bubble; an empty text is none. */
export function replyBubbles(text: string, max = REPLY_BUBBLES_MAX): string[] {
  const bubbles: string[] = [];
  for (const block of paragraphs(text)) {
    if (bubbles.length > 0 && joinsPrevious(bubbles.at(-1)!, block)) bubbles[bubbles.length - 1] += `\n\n${block}`;
    else bubbles.push(block);
  }
  return bubbles.length > max ? [...bubbles.slice(0, max - 1), bubbles.slice(max - 1).join("\n\n")] : bubbles;
}

/** The pause before the next bubble shows, as if it were being typed: longer for more words, never long. */
export function replyBubbleGapMs(next: string): number {
  return Math.min(2200, 600 + 20 * next.length);
}
