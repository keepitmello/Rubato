import * as Electron from "electron";

// The macOS menu bar in the interface language (Settings > Appearance >
// Interface > Language; the page itself is apps/web/src/rubatoI18n.ts). The
// menu is built once from DesktopApplicationMenu's English template; this
// keeps that template and builds it again in Korean when the client setting
// says so, which the window reads at start and writes on every change.

type MenuLanguage = "en" | "ko";

// macOS's own Korean names where the system has one.
const LABELS: Readonly<Record<string, string>> = {
  File: "파일",
  Edit: "편집",
  View: "보기",
  Speech: "말하기",
  "Check for Updates...": "업데이트 확인하기...",
  "Settings...": "설정...",
  "Paste as Text": "텍스트로 붙여넣기",
  Reload: "새로고침",
  "Force Reload": "강제 새로고침",
  "Toggle Developer Tools": "개발자 도구 전환하기",
  "Actual Size": "실제 크기",
  "Zoom In": "확대",
  "Zoom Out": "축소",
};

const ROLE_LABELS: Readonly<Partial<Record<string, string>>> = {
  services: "서비스",
  hideOthers: "기타 가리기",
  unhide: "모두 보기",
  close: "윈도우 닫기",
  undo: "실행 취소",
  redo: "실행 복귀",
  cut: "오려두기",
  copy: "복사하기",
  paste: "붙여넣기",
  delete: "삭제",
  selectAll: "모두 선택",
  startSpeaking: "말하기 시작",
  stopSpeaking: "말하기 중단",
  togglefullscreen: "전체 화면 전환하기",
  windowMenu: "윈도우",
  help: "도움말",
};

/** "About Rubato", "Hide Rubato", "Quit Rubato" keep the app name. */
function nameLabel(label: string): string | null {
  const match = /^(About|Hide|Quit) (.+)$/.exec(label);
  if (!match) return null;
  const name = match[2]!;
  return match[1] === "About" ? `${name} 정보` : match[1] === "Hide" ? `${name} 가리기` : `${name} 종료`;
}

export function localizeMenuTemplate(
  template: ReadonlyArray<Electron.MenuItemConstructorOptions>,
  language: MenuLanguage,
): Electron.MenuItemConstructorOptions[] {
  if (language === "en") return [...template];
  return template.map((item) => {
    const label = item.label === undefined ? undefined : (LABELS[item.label] ?? nameLabel(item.label) ?? item.label);
    const roleLabel = item.label === undefined && item.role ? ROLE_LABELS[item.role] : undefined;
    const submenu = Array.isArray(item.submenu) ? localizeMenuTemplate(item.submenu, language) : item.submenu;
    return {
      ...item,
      ...(label !== undefined ? { label } : roleLabel !== undefined ? { label: roleLabel } : {}),
      ...(submenu !== undefined ? { submenu } : {}),
    };
  });
}

let language: MenuLanguage = "en";
let lastTemplate: ReadonlyArray<Electron.MenuItemConstructorOptions> | null = null;

/** DesktopApplicationMenu hands its template here and installs what comes back. */
export function rememberRubatoMenu(
  template: ReadonlyArray<Electron.MenuItemConstructorOptions>,
): Electron.MenuItemConstructorOptions[] {
  lastTemplate = template;
  return localizeMenuTemplate(template, language);
}

export function setRubatoMenuLanguage(next: MenuLanguage | undefined): void {
  const wanted = next === "ko" ? "ko" : "en";
  if (wanted === language) return;
  language = wanted;
  if (!lastTemplate) return;
  try {
    Electron.Menu.setApplicationMenu(Electron.Menu.buildFromTemplate(localizeMenuTemplate(lastTemplate, language)));
  } catch {
    // The menu keeps its last language; the next change tries again.
  }
}
