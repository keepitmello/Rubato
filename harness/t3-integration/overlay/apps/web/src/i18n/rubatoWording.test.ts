import { describe, expect, it } from "vite-plus/test";

import dictionary from "../rubatoI18n.ko.json";
import type { UiDictionary } from "../rubatoI18n";
import { sourceText, withRubatoWording, type Catalog } from "./rubatoWording";
import english from "./translations/en.json";
import korean from "./translations/ko.json";

const rubato = dictionary as unknown as UiDictionary;
const hashOf = (source: unknown) =>
  Object.entries(english as Catalog).find(([, value]) => JSON.stringify(value) === JSON.stringify(source))![0];

describe("an ICU source as the page shows it", () => {
  it("unquotes apostrophes and numbers simple values", () => {
    expect(sourceText("''{name}'' exceeds the {size} attachment limit.")).toEqual({
      key: "'{0}' exceeds the {1} attachment limit.",
      names: ["name", "size"],
    });
    expect(sourceText("Press '{' to open")).toEqual({ key: "Press { to open", names: [] });
    expect(sourceText("Don't stop")).toEqual({ key: "Don't stop", names: [] });
  });

  it("reads a plural as its other branch, Korean having one form", () => {
    expect(sourceText("{count, plural, one {# file} other {# files}}")).toEqual({ key: "{0} files", names: ["count"] });
    expect(sourceText('{count, plural, other {Remove "{label}" and its # threads?}}')).toEqual({
      key: 'Remove "{0}" and its {1} threads?',
      names: ["label", "count"],
    });
  });

  it("leaves select messages and plurals with exact branches to T3", () => {
    expect(sourceText("{term, select, mr {merge request} other {pull request}}")).toBeNull();
    expect(sourceText("{count, plural, =0 {No files} other {# files}}")).toBeNull();
  });
});

describe("Rubato's wording over T3's Korean catalog", () => {
  const merged = withRubatoWording(korean as Catalog, english as Catalog, rubato);

  it("replaces T3's Korean where Rubato's dictionary words the same English differently", () => {
    const add = hashOf("Add a project");
    expect((korean as Catalog)[add]).toBe("프로젝트 추가");
    expect(merged[add]).toBe(rubato.exact["Add a project"]);
  });

  it("fills a template with the source's own value names", () => {
    const hash = hashOf('Remove project "{label}"?');
    expect(merged[hash]).toBe('"{label}" 프로젝트를 제거할까요?');
  });

  it("doubles apostrophes so ICU shows them", () => {
    const hash = hashOf("A comment is anchored to the whole change, so switch to All commits to write one.");
    expect(merged[hash]).toContain("''모든 커밋''");
  });

  it("rewrites a <T> entry around its values", () => {
    const hash = hashOf(["Publishing repository to ", { i: 1, k: "_gt_value_1", v: "v" }, "..."]);
    expect(merged[hash]).toEqual([{ i: 1, k: "_gt_value_1", v: "v" }, "에 repo 게시 중..."]);
  });

  it("puts Rubato's wording on a plural message", () => {
    const hash = hashOf("{count, plural, one {{count} providers updated} other {{count} providers updated}}");
    expect((korean as Catalog)[hash]).toBe("{count, plural, other {제공자 {count}개 업데이트됨}}");
    expect(merged[hash]).toBe("프로바이더 {count}개 업데이트됨");
  });

  it("keeps T3's Korean where Rubato has no entry", () => {
    const untouched = Object.keys(korean as Catalog).filter((hash) => merged[hash] === (korean as Catalog)[hash]);
    expect(untouched.length).toBeGreaterThan(4000);
  });
});
