#!/usr/bin/env node
// Lists the interface text of an applied T3 tree as dictionary keys, in the
// form the page translation looks them up (overlay/apps/web/src/rubatoI18n.ts):
// whitespace collapsed, {n} for a runtime value, <n/> for a child element
// between words. Each key carries its file, line and surrounding source so a
// translator can tell a button from a heading.
//
//   node extract.mjs --t3 ~/.rubato/t3-source > strings.json
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

/** TypeScript 7 ships no compiler API; T3's tree still carries a 6.x for tools. */
export function loadTypeScript(t3) {
  const store = path.join(t3, 'node_modules/.pnpm');
  const candidates = readdirSync(store).filter((name) => /^typescript@[56]\./.test(name)).sort().reverse();
  if (candidates.length === 0) throw new Error(`No TypeScript 5/6 under ${store}`);
  return createRequire(path.join(store, candidates[0], 'node_modules/typescript/package.json'))('typescript');
}

/** Props and attributes whose string is shown to a person. */
const SHOWN = /^(aria-label|aria-description|ariaLabel|title|placeholder|label|description|tooltip|hint|message|text|heading|caption|alt|summary|subtitle|detail|emptyText|emptyMessage|helperText|confirmLabel|cancelLabel|actionLabel|buttonLabel|submitLabel|triggerLabel|errorMessage|successMessage|body|header|footer)$/;
const NOTIFY = /toast|notify|^alert$|^confirm$/i;

export function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** JSX text as React renders it: lines trimmed, blank lines dropped, joined with a space. */
export function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  if (lines.length === 1) return raw;
  return lines
    .map((line, index) => {
      let value = line;
      if (index > 0) value = value.replace(/^[ \t]+/, '');
      if (index < lines.length - 1) value = value.replace(/[ \t]+$/, '');
      return value;
    })
    .filter((line) => line.length > 0)
    .join(' ');
}

const hasWords = (text) => /\p{L}{2}/u.test(text);
/** Identifiers, keys, class lists, paths and URLs are not interface text. */
function looksLikeCode(text) {
  if (/^(https?:|mailto:|\/|\.\/|#|var\(|data:)/.test(text)) return true;
  if (/[{};=]|=>/.test(text.replace(/\{\d+\}/g, ''))) return true;
  if (/^[a-z0-9]+([-_:.\/][a-z0-9]+)+$/.test(text)) return true;
  if (/^[a-z][a-zA-Z0-9]*$/.test(text)) return true;
  return false;
}

export function extractFile(ts, fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = source.split('\n');
  const found = [];
  const add = (key, node, where) => {
    key = normalize(key);
    if (!hasWords(key.replace(/\{\d+\}|<\d+\/>/g, ' '))) return;
    if (looksLikeCode(key)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line;
    found.push({ key, where, line: line + 1, context: lines.slice(Math.max(0, line - 3), line + 4).join('\n') });
  };

  const literal = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
  };
  const template = (node) => {
    if (!ts.isTemplateExpression(node)) return null;
    let text = node.head.text;
    node.templateSpans.forEach((span, index) => { text += `{${index}}` + span.literal.text; });
    return text;
  };
  const rendersElement = (node) => {
    let element = false;
    (function visit(child) {
      if (element) return;
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) { element = true; return; }
      if (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) return;
      ts.forEachChild(child, visit);
    })(node);
    return element;
  };

  // An element's own text, the unit the page translates.
  const element = (node, children) => {
    const runs = [{ text: '', words: false, value: false }];
    let values = 0;
    for (const child of children) {
      if (ts.isJsxText(child)) {
        const text = jsxText(child.text);
        runs.at(-1).text += text;
        if (hasWords(text)) runs.at(-1).words = true;
      } else if (ts.isJsxExpression(child)) {
        if (!child.expression) continue;
        const text = literal(child.expression);
        if (text !== null) {
          runs.at(-1).text += text;
          if (hasWords(text)) runs.at(-1).words = true;
        } else if (rendersElement(child.expression)) {
          runs.push({ text: '', words: false, value: false });
        } else {
          runs.at(-1).text += `{${values++}}`;
          runs.at(-1).value = true;
        }
      } else {
        runs.push({ text: '', words: false, value: false });
      }
    }
    // As the page sees it (rubatoI18n.ts translateElement): one entry per
    // element, with <n/> only when text sits on both sides of a child element.
    const blank = (run) => !run.value && run.text.trim().length === 0;
    const filled = runs.filter((run) => !blank(run));
    if (!runs.some((run) => run.words)) return;
    if (filled.length === 1) {
      // Renumber the values of this run alone.
      let index = 0;
      add(filled[0].text.replace(/\{\d+\}/g, () => `{${index++}}`), node, 'text');
      return;
    }
    let first = 0;
    let last = runs.length - 1;
    while (blank(runs[first])) first++;
    while (blank(runs[last])) last--;
    let index = 0;
    const key = runs.slice(first, last + 1)
      .map((run, at) => (at === 0 ? '' : `<${at - 1}/>`) + run.text)
      .join('')
      .replace(/\{\d+\}/g, () => `{${index++}}`);
    add(key, node, 'sentence');
  };

  // A string in a place that shows it: a shown prop or attribute, a branch of
  // an expression rendered as a child, or a notification call.
  const shownPlace = (node) => {
    let parent = node.parent;
    if (parent && ts.isBinaryExpression(parent) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)) return null;
    while (parent && (ts.isConditionalExpression(parent) || ts.isParenthesizedExpression(parent) ||
      ts.isBinaryExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression?.(parent))) {
      if (ts.isConditionalExpression(parent) && parent.condition === node) return null;
      node = parent;
      parent = parent.parent;
    }
    if (!parent) return null;
    if (ts.isJsxExpression(parent)) {
      const owner = parent.parent;
      if (ts.isJsxElement(owner) || ts.isJsxFragment(owner)) return 'child';
      if (ts.isJsxAttribute(owner) && SHOWN.test(owner.name.getText())) return owner.name.getText();
      return null;
    }
    if (ts.isJsxAttribute(parent) && SHOWN.test(parent.name.getText())) return parent.name.getText();
    if (ts.isPropertyAssignment(parent) && SHOWN.test(parent.name.getText())) return parent.name.getText();
    if (ts.isCallExpression(parent) && NOTIFY.test(parent.expression.getText().split('.').pop())) return 'notice';
    if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
      // Label helpers: function fooLabel() { return "..."; }
      let fn = parent;
      while (fn && !ts.isFunctionDeclaration(fn) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && !ts.isMethodDeclaration(fn)) fn = fn.parent;
      let name = fn?.name?.getText();
      if (!name && fn?.parent && ts.isVariableDeclaration(fn.parent)) name = fn.parent.name.getText();
      if (name && /(Label|Title|Text|Message|Description|Copy|Tooltip|Placeholder|Caption|Summary|Hint)$/.test(name)) return 'helper';
    }
    return null;
  };

  (function visit(node) {
    if (ts.isJsxElement(node)) element(node, node.children);
    else if (ts.isJsxFragment(node)) element(node, node.children);
    else {
      const text = literal(node) ?? template(node);
      if (text !== null && !(node.parent && ts.isJsxExpression(node.parent) && (ts.isJsxElement(node.parent.parent) || ts.isJsxFragment(node.parent.parent)) && literal(node) !== null)) {
        const where = shownPlace(node);
        if (where) add(text, node, where);
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
  return found;
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!/^(node_modules|__tests__|test|tests|dist)$/.test(entry.name)) files.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|stories)\.|\.d\.ts$|\.logic\.test/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Every key once, with the places it appears (the first three keep their source). */
export function extract(t3) {
  const ts = loadTypeScript(t3);
  const roots = ['apps/web/src'];
  const byKey = new Map();
  for (const root of roots) {
    for (const file of sourceFiles(path.join(t3, root))) {
      const relative = path.relative(t3, file);
      for (const item of extractFile(ts, file, readFileSync(file, 'utf8'))) {
        const entry = byKey.get(item.key) ?? { key: item.key, places: [] };
        if (entry.places.length < 3) entry.places.push({ file: relative, line: item.line, where: item.where, context: item.context });
        else entry.more = (entry.more ?? 0) + 1;
        byKey.set(item.key, entry);
      }
    }
  }
  return [...byKey.values()];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { t3: { type: 'string' } } });
  if (!values.t3) throw new Error('Usage: node extract.mjs --t3 /path/to/applied/t3code > strings.json');
  process.stdout.write(JSON.stringify(extract(path.resolve(values.t3)), null, 1) + '\n');
}
