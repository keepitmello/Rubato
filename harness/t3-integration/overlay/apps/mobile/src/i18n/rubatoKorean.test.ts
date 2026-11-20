// Rubato: the phone's Korean catalog carries Rubato's wording wherever Rubato's dictionary has the
// same English, as the desktop's does (shell-edits.mjs, I18nProvider).
import dictionary from "@t3tools/shared/rubatoI18n.ko.json";
import { withRubatoWording, type Catalog, type UiDictionary } from "@t3tools/shared/rubatoWording";
import { describe, expect, it } from "vite-plus/test";

import english from "./translations/en.json";
import korean from "./translations/ko.json";

const rubato = dictionary as unknown as UiDictionary;
const merged = withRubatoWording(korean as Catalog, english as Catalog, rubato);
const hashOf = (source: string) => Object.entries(english).find(([, value]) => value === source)![0];

describe("the phone's Korean catalog", () => {
  it("uses Rubato's word for a term the user chose", () => {
    expect(merged[hashOf("Side chat")]).toBe(rubato.exact["Side chat"]);
    expect(merged[hashOf("Side chat")]).not.toBe((korean as Catalog)[hashOf("Side chat")]);
  });

  it("takes every plain phrase the dictionary has from the dictionary", () => {
    const plain = Object.entries(english).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && rubato.exact[entry[1]] !== undefined,
    );
    expect(plain.length).toBeGreaterThan(0);
    for (const [hash, source] of plain) expect(merged[hash]).toBe(rubato.exact[source]);
  });

  it("keeps T3's Korean for what the dictionary does not have", () => {
    const [hash] = Object.entries(english).find(
      ([key, source]) => typeof source === "string" && !/[{}]/.test(source) && rubato.exact[source] === undefined && key in korean,
    )!;
    expect(merged[hash]).toBe((korean as Catalog)[hash]);
  });
});
