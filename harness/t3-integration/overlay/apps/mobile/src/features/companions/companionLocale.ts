// The companion screens' language follows the app's (copy.ts): gt-react-native's locale, the
// language Settings › Language picked or the phone's when it follows the system.
import { getLocale, useLocale } from "gt-react-native";
import { useEffect } from "react";

import { setCopyLocale, setCopyLocaleSource } from "./copy";

// Read on first use, after the app set its translation layer up.
setCopyLocaleSource(() => getLocale());

/** Keeps the companion words in step with a language switch; mounted once with the call host. */
export function useCompanionLocale() {
  const locale = useLocale();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- copy.ts is read outside React (alerts, the call screen's native labels), so it keeps the committed language in a module value
  useEffect(() => setCopyLocale(locale), [locale]);
}
