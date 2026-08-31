// senpi 내장 FooterComponent 를 쓰지 않는다. InteractiveMode 생성자가
// `new FooterComponent` 대신 이 팩토리를 부르도록 로드 변환만 한다.
// 푸터 그리는 코드의 정본은 이 파일과 statusline.mjs 다.
import { fallbackStatusLines, footerHost } from "./extensions/statusline.mjs";

const MARKER = "rubato.footer.injected";

const FOOTER_ASSIGNMENT = `        this.footer = this.chrome
            ? this.chrome.createFooter(this.session, this.footerDataProvider)
            : new FooterComponent(this.session, this.footerDataProvider);`;

const FOOTER_REPLACEMENT = "        this.footer = __rubatoCreateFooter(this.session, this.footerDataProvider);";

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`rubato footer transform drift: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function isRubatoFooterModuleUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js");
}

export function rubatoFooterHref() {
  return import.meta.url;
}

export function injectRubatoFooter(source, href = rubatoFooterHref()) {
  if (source.includes(MARKER)) return source;
  const next = replaceOnce(source, FOOTER_ASSIGNMENT, FOOTER_REPLACEMENT, "footer assignment");
  return `${next}
// ${MARKER}
const { createRubatoFooter: __rubatoCreateFooter } = await import(${JSON.stringify(href)});
`;
}

export class RubatoFooter {
  constructor(session, footerData) {
    this.session = session;
    this.footerData = footerData;
  }

  setSession(session) {
    this.session = session;
  }

  setAutoCompactEnabled() {}

  invalidate() {}

  dispose() {}

  render(width) {
    const host = footerHost();
    try {
      const painted = host?.paint?.(this, width);
      if (Array.isArray(painted) && painted.length > 0) return painted;
    } catch {
      // Host painter is best-effort. This component must still paint a Rubato line.
    }
    return fallbackStatusLines(this, width);
  }
}

export function createRubatoFooter(session, footerData) {
  return new RubatoFooter(session, footerData);
}
