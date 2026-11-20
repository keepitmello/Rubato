// Rubato's Korean wording over T3's own Korean catalog. The matching is shared with the phone
// (@t3tools/shared/rubatoWording); this loads the web app's English catalog and the dictionary.
import { withRubatoWording, type Catalog, type UiDictionary } from "@t3tools/shared/rubatoWording";

export { catalogKey, sourceText, withRubatoWording, type Catalog } from "@t3tools/shared/rubatoWording";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The Korean catalog the app loads; T3's alone when either Rubato file fails to load. */
export function loadRubatoKorean(upstream: unknown): Promise<unknown> {
  if (!isRecord(upstream)) return Promise.resolve(upstream);
  return Promise.all([import("./translations/en.json"), import("@t3tools/shared/rubatoI18n.ko.json")]).then(
    ([english, dictionary]) =>
      withRubatoWording(
        upstream,
        english.default as Catalog,
        dictionary.default as unknown as UiDictionary,
      ),
    () => upstream,
  );
}
