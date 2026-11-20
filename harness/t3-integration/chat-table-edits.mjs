// Chat tables fit the chat width and wrap inside their cells, Korean between words.
//
// T3 drew every cell on one line, cut at 24rem with an ellipsis, and let the
// table grow to its content width (min-width: max-content), behind a footer
// toggle that wrapped the cells on request. Its own table now takes the chat
// width, wraps every cell, and keeps only the copy menu, so what is left here
// is the Korean wrapping: word-break stays keep-all, and overflow-wrap normal
// as T3's note says, so a column breaks between words rather than between
// characters.
export const chatTableOverlays = [];

const t3TableCss = [
  '.chat-markdown table {',
  '  width: 100%;',
  '  border-collapse: collapse;',
  '  overflow-wrap: normal;',
  '  word-break: normal;',
].join('\n');

const rubatoTableCss = [
  '.chat-markdown table {',
  '  width: 100%;',
  '  border-collapse: collapse;',
  '  overflow-wrap: normal;',
  '  /* Rubato: Korean wraps between words, not between characters (chat-table-edits.mjs). */',
  '  word-break: keep-all;',
].join('\n');

export const chatTableEdits = {
  'apps/web/src/index.css': [
    [t3TableCss, rubatoTableCss, 'replace'],
  ],
};
