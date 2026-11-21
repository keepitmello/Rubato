// A single ~ in a reply stays a tilde on the Mac and the phone; only ~~double~~ strikes.
//
// Replies write ranges as 0.9~2.3분 and 5~11턴. GFM reads a lone ~ as a strikethrough
// delimiter, so the two tildes struck out everything between them. T3 already turns
// single-tilde strikethrough off for the user's own messages (CHAT_USER_MARKDOWN_REMARK_PLUGINS);
// the Mac's chat lists get the same remark-gfm option here.
//
// The phone parses with md4c (react-native-enriched-markdown, GitHub flavor), which has
// no such option, so markdownForNativeParsing escapes each lone ~ outside code and URLs
// before md4c sees it (rubatoSingleTilde.ts).
export const markdownTildeOverlays = [
  'apps/mobile/src/lib/rubatoSingleTilde.ts',
  'apps/mobile/src/lib/rubatoSingleTilde.test.ts',
];

const singleTildeOff = '  // Rubato: a lone ~ is a tilde, not strikethrough (markdown-tilde-edits.mjs).\n  [remarkGfm, { singleTilde: false }],';

export const markdownTildeEdits = {
  'packages/shared/src/markdownPipeline.ts': [
    ['export const CHAT_MARKDOWN_REMARK_PLUGINS: PluggableList = [\n  remarkGfm,',
      `export const CHAT_MARKDOWN_REMARK_PLUGINS: PluggableList = [\n${singleTildeOff}`, 'replace'],
    ['export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: PluggableList = [\n  remarkGfm,',
      `export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: PluggableList = [\n${singleTildeOff}`, 'replace'],
  ],
  // T3's own case expected ~url~ to strike; with single tildes off the tildes stay text.
  'packages/shared/src/markdownPipeline.test.ts': [
    ['    ["~https://example.com/name~", `~~${link("https://example.com/name")}~~`],',
      '    ["~https://example.com/name~", `~${link("https://example.com/name~")}`],', 'replace'],
  ],
  'apps/mobile/src/lib/markdownDocument.ts': [
    ['import { hasRightToLeftLetter, textDirection } from "@t3tools/shared/textDirection";\n',
      'import { hasRightToLeftLetter, textDirection } from "@t3tools/shared/textDirection";\nimport { markdownWithLiteralSingleTildes } from "./rubatoSingleTilde";\n', 'replace'],
    ['  return markdownWithWindowsPathDestinations(markdownWithHtml(markdown));',
      '  return markdownWithLiteralSingleTildes(markdownWithWindowsPathDestinations(markdownWithHtml(markdown)));', 'replace'],
  ],
};
