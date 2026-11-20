import { ClientSettingsSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { withRubatoUiLanguage } from "./rubatoUiLanguage.ts";

const decode = (document: unknown) =>
  Schema.decodeUnknownSync(ClientSettingsSchema)(withRubatoUiLanguage(document));

describe("Rubato's old uiLanguage setting", () => {
  it("opens a file with only uiLanguage ko in Korean", () => {
    expect(decode({ uiLanguage: "ko" }).language).toBe("ko");
  });

  it("lets T3's language decide once it is saved", () => {
    expect(decode({ uiLanguage: "ko", language: "en" }).language).toBe("en");
    expect(decode({ uiLanguage: "ko", language: "system" }).language).toBe("system");
  });

  it("keeps T3's default for English and for files without either key", () => {
    expect(decode({ uiLanguage: "en" }).language).toBe("en");
    expect(decode({}).language).toBe("en");
  });

  it("drops the old key on the next save", () => {
    expect(Object.hasOwn(decode({ uiLanguage: "ko" }), "uiLanguage")).toBe(false);
  });
});
