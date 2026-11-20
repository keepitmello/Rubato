import * as Effect from "effect/Effect";
import { msg } from "gt-i18n";
import { describe, expect, it } from "vite-plus/test";

import * as ElectronApp from "../electron/ElectronApp.ts";
import { applyLanguage, m } from "./messages.ts";
import english from "./translations/en.json" with { type: "json" };
import korean from "./translations/ko.json" with { type: "json" };

// applyLanguage reads only the system languages, and only when the setting is "system".
const electronApp = {
  preferredSystemLanguages: Effect.succeed(["en-US"]),
} as unknown as ElectronApp.ElectronApp["Service"];
const switchTo = (language: string) =>
  Effect.runPromise(applyLanguage(language).pipe(Effect.provideService(ElectronApp.ElectronApp, electronApp)));

describe("the desktop's Korean wording", () => {
  it("keeps the menu bar's names, then Rubato's dictionary, then T3's Korean", async () => {
    await switchTo("ko");
    // Menus as the user has them today (T3's own: 새로 고침, 창 닫기, 전체 선택).
    expect(m(msg("Reload"))).toBe("새로고침");
    expect(m(msg("Close Window"))).toBe("윈도우 닫기");
    expect(m(msg("Select All", { $context: "Edit menu item" }))).toBe("모두 선택");
    expect(m(msg("Edit", { $context: "menu bar title" }))).toBe("편집");
    expect(m(msg("About {appName}"), { appName: "Rubato" })).toBe("Rubato 정보");
    // A dialog button in the dictionary's wording (T3's own: 취소).
    expect(m(msg("Cancel"))).toBe("취소하기");
    expect(m(msg("Allow", { $context: "button, grants a site permission" }))).toBe("허용하기");
    // Neither has it: T3's Korean.
    const hash = Object.entries(english).find(([, source]) => source === "Bring All to Front")![0];
    expect(m(msg("Bring All to Front"))).toBe((korean as Record<string, string>)[hash]);

    await switchTo("en");
    expect(m(msg("Reload"))).toBe("Reload");
  });
});
