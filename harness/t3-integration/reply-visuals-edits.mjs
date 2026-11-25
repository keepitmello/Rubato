// A reply can show a picture it drew and colour a table cell, on the Mac and the phone (user,
// 2026-11-25: ChatGPT-style answers, "자유 그림이 되는 게 가장 표현하기 좋을 거 같은데 유연하고").
//
// - A ```svg fence is drawn as its picture, the fence title (```svg title="…") as its caption. The
//   web chat inlines DOMPurify's output so `currentColor` and the font follow the theme; the phone
//   draws it with react-native-svg in the text colour. Markup that is not one <svg> stays code.
// - <span data-tone="good|warn|bad"> colours a cell's words on the web chat (success, warning and
//   destructive foregrounds, light and dark); the phone, which flattens HTML into Markdown, puts
//   🟢 🟡 🔴 before them instead.
//
// Telegram, which shows plain text, gets the same reply through harness/companion/messenger
// (svg-figures.mjs: the picture as a PNG photo; reply-text.mjs: dots, table rows as lines).
export const replyVisualsOverlays = [
  'apps/web/src/components/chat/RubatoSvgFigure.tsx',
  'apps/web/src/components/chat/RubatoSvgFigure.browser.test.tsx',
  'apps/mobile/src/lib/rubatoSvgFigure.ts',
  'apps/mobile/src/lib/rubatoSvgFigure.test.ts',
  'apps/mobile/src/native/RubatoSvgBlock.tsx',
];

const svgFigureBranch = `    if (language === "svg") {
      // Rubato: a drawn picture, not its source (reply-visuals-edits.mjs).
      const svgStreaming = isStreaming && !isClosedCodeFence(node, text, codeBlock.code);
      const svgFigure = svgStreaming ? null : rubatoSvgFigureMarkup(codeBlock.code);
      if (svgStreaming || svgFigure) {
        return (
          <RubatoSvgFigure
            figure={svgFigure}
            title={fenceTitle}
            onExpand={(src) =>
              expandMedia({
                images: [{ src, name: fenceTitle ?? gt("Diagram"), mimeType: "image/svg+xml" }],
                index: 0,
              })
            }
          />
        );
      }
    }
`;

const replyVisualsCss = `/* Rubato: a reply's own drawing and its coloured words (reply-visuals-edits.mjs). */
.chat-markdown .rubato-svg-figure svg {
  display: block;
  max-width: 100%;
  height: auto;
  color: inherit;
  font-family: inherit;
  overflow: visible;
}

.chat-markdown span[data-tone] {
  font-weight: 600;
}

.chat-markdown span[data-tone="good"] {
  color: var(--success-foreground);
}

.chat-markdown span[data-tone="warn"] {
  color: var(--warning-foreground);
}

.chat-markdown span[data-tone="bad"] {
  color: var(--destructive-foreground);
}

`;

export const replyVisualsEdits = {
  'apps/web/src/components/ChatMarkdown.tsx': [
    ['import { MarkdownMermaidCodeBlock } from "./chat/MarkdownMermaidCodeBlock";\n',
      'import { RubatoSvgFigure, rubatoSvgFigureMarkup } from "./chat/RubatoSvgFigure";\n'],
    ['    if (language === "mermaid") {\n      return (\n        <MarkdownMermaidCodeBlock', svgFigureBranch],
  ],
  'apps/web/src/index.css': [
    ['/* Markdown assumes inline images — GitHub comments lay button images out in a row — and the', replyVisualsCss],
  ],
  'packages/shared/src/markdownPipeline.ts': [
    ['    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],\n',
      '    // Rubato: a cell\'s words coloured by tone (reply-visuals-edits.mjs).\n    span: [["dataTone", "good", "warn", "bad"]],\n'],
  ],
  'apps/mobile/src/lib/markdownDocument.ts': [
    ['import { isWindowsAbsolutePath } from "@t3tools/shared/path";\n',
      'import { RUBATO_TONE_DOTS } from "./rubatoSvgFigure";\n'],
    ['  if (/^<\\/?(?:p|div|details)\\b/i.test(tag)) return blockBreak;\n  return "";\n',
      '  // Rubato: a toned cell shows its dot; the phone cannot colour words (reply-visuals-edits.mjs).\n  if (/^<span\\b/i.test(tag)) return RUBATO_TONE_DOTS[attribute(tag, "data-tone") ?? ""] ?? "";\n'],
  ],
  'apps/mobile/src/native/EnrichedMarkdownText.tsx': [
    ['import { MermaidCodeBlock } from "./MermaidCodeBlock";\n',
      'import { rubatoSvgBlock } from "./RubatoSvgBlock";\nimport { svgFenceTitles } from "../lib/rubatoSvgFigure";\n'],
    ['    code: (block: MarkdownCodeBlock) =>\n      codeBlockElement(',
      '    code: (block: MarkdownCodeBlock) =>\n      // Rubato: a complete ```svg fence draws its picture (reply-visuals-edits.mjs).\n      (block.language.toLowerCase() === "svg" && block.isComplete\n        ? rubatoSvgBlock(block.code, svgFenceTitles(props.markdown).get(block.code.trim()), props.textStyle)\n        : undefined) ??\n      codeBlockElement(', 'replace'],
  ],
};
