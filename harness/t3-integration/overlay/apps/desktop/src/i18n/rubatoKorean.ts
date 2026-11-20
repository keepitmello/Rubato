import {
  withRubatoWording,
  type Catalog,
  type UiDictionary,
} from "@t3tools/shared/rubatoWording";

// The desktop's Korean catalog (menus, native dialogs) with Rubato's wording, the same rule
// as the web app and the phone: Rubato's words wherever they have the same English, T3's
// Korean for the rest. Keyed by English, so a T3 update needs no change here.

/**
 * The menu bar as Rubato named it before T3 translated menus (macOS's own Korean names where
 * the system has one). It comes first: a menu keeps the words the user already knows.
 */
export const RUBATO_MENU_WORDING: UiDictionary = {
  exact: {
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
    Services: "서비스",
    "Hide Others": "기타 가리기",
    "Show All": "모두 보기",
    "Close Window": "윈도우 닫기",
    Undo: "실행 취소",
    Redo: "실행 복귀",
    Cut: "오려두기",
    Copy: "복사하기",
    Paste: "붙여넣기",
    Delete: "삭제",
    "Select All": "모두 선택",
    "Start Speaking": "말하기 시작",
    "Stop Speaking": "말하기 중단",
    "Toggle Full Screen": "전체 화면 전환하기",
    Window: "윈도우",
    Help: "도움말",
  },
  templates: [
    ["About {0}", "{0} 정보"],
    ["Hide {0}", "{0} 가리기"],
    ["Quit {0}", "{0} 종료"],
  ],
};

type StringCatalog = Readonly<Record<string, string>>;

/** Menu wording, then Rubato's dictionary, then T3's Korean. */
export function rubatoKoreanCatalog(
  upstream: StringCatalog,
  english: Catalog,
  dictionary: UiDictionary,
): StringCatalog {
  const merged = withRubatoWording(
    withRubatoWording(upstream, english, dictionary),
    english,
    RUBATO_MENU_WORDING,
  );
  // The desktop's sources are plain strings, so every entry stays a string.
  const catalog: Record<string, string> = {};
  for (const [hash, value] of Object.entries(merged)) {
    if (typeof value === "string") catalog[hash] = value;
  }
  return catalog;
}

/** The Korean catalog the desktop loads; T3's alone when a Rubato file fails to load. */
export function loadRubatoKorean(upstream: StringCatalog): Promise<StringCatalog> {
  return Promise.all([
    import("./translations/en.json", { with: { type: "json" } }),
    import("@t3tools/shared/rubatoI18n.ko.json", { with: { type: "json" } }),
  ]).then(
    ([english, dictionary]) =>
      rubatoKoreanCatalog(
        upstream,
        english.default as Catalog,
        dictionary.default as unknown as UiDictionary,
      ),
    () => upstream,
  );
}
