// Rubato: the app's over-the-air updates (EAS Update, mobile/update-ios.sh) are looked for on every
// launch and when the app comes back after a short while, from the app root. T3 starts the same
// checks from its thread home, which Rubato does not open first (the companion tab is), so a launch
// that never visits Threads would miss them. Both checks start once however often they are asked.
import { useEffect } from "react";

import { checkForAppUpdateOnLaunch, startAppUpdateForegroundRecheck } from "../updates/app-updates";

export function RubatoUpdateHost() {
  useEffect(() => {
    void checkForAppUpdateOnLaunch();
    startAppUpdateForegroundRecheck();
  }, []);
  return null;
}
