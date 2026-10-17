import { describe, expect, it, vi } from "vite-plus/test";

const installed: unknown[] = [];
vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: unknown) => template,
    setApplicationMenu: (menu: unknown) => installed.push(menu),
  },
}));

const { localizeMenuTemplate, rememberRubatoMenu, setRubatoMenuLanguage } = await import("./rubatoMenuLanguage.ts");

const click = () => undefined;
const template = [
  { label: "Rubato", submenu: [{ role: "about" as const, label: "About Rubato" }, { label: "Settings...", click }, { role: "quit" as const, label: "Quit Rubato" }] },
  { label: "Edit", submenu: [{ role: "undo" as const }, { role: "copy" as const }, { label: "Paste as Text", click }] },
  { role: "windowMenu" as const },
];

describe("menu language", () => {
  it("names menus, items and system roles in Korean and keeps clicks", () => {
    const korean = localizeMenuTemplate(template, "ko");
    expect(korean.map((item) => item.label)).toEqual(["Rubato", "편집", "윈도우"]);
    const app = korean[0]!.submenu as Array<{ label?: string; click?: unknown }>;
    expect(app.map((item) => item.label)).toEqual(["Rubato 정보", "설정...", "Rubato 종료"]);
    expect(app[1]!.click).toBe(click);
    const edit = korean[1]!.submenu as Array<{ label?: string; role?: string }>;
    expect(edit.map((item) => item.label)).toEqual(["실행 취소", "복사하기", "텍스트로 붙여넣기"]);
    expect(edit[0]!.role).toBe("undo");
  });

  it("leaves English as built", () => {
    expect(localizeMenuTemplate(template, "en")).toEqual(template);
  });

  it("rebuilds the installed menu when the language changes, and only then", () => {
    rememberRubatoMenu(template);
    setRubatoMenuLanguage("ko");
    setRubatoMenuLanguage("ko");
    setRubatoMenuLanguage(undefined);
    expect(installed).toHaveLength(2);
    expect((installed[0] as Array<{ label?: string }>)[1]!.label).toBe("편집");
    expect((installed[1] as Array<{ label?: string }>)[1]!.label).toBe("Edit");
  });
});
