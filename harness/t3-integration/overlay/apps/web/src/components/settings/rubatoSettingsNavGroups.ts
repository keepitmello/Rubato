// The settings menu grouped and ordered as on Rubato v0.1.0 (user ba4754d0): App · Work · Tools,
// then the pages without a heading. Only the menu moves; every page keeps the rows T3 v0.1.11 put
// on it. The groups are built from T3's own list, so a page T3 adds or drops later needs no edit
// here: one this list does not name joins the last group, one T3 dropped is left out.
import { msg } from "gt-react";

import type { SettingsPath } from "./settingsSearch";

export interface SettingsNavGroup {
  readonly heading: string;
  readonly headingHidden?: true;
  readonly paths: ReadonlyArray<SettingsPath>;
}

const RUBATO_GROUPS: ReadonlyArray<{
  readonly heading: string;
  readonly headingHidden?: true;
  readonly paths: ReadonlyArray<string>;
}> = [
  {
    heading: msg("App"),
    paths: ["/settings/general", "/settings/appearance", "/settings/keybindings", "/settings/voice"],
  },
  {
    heading: msg("Work"),
    paths: [
      "/settings/companion",
      "/settings/providers",
      "/settings/chat",
      "/settings/diffs",
      "/settings/threads",
      "/settings/projects",
      "/settings/source-control",
      "/settings/worktrees",
    ],
  },
  {
    heading: msg("Tools"),
    paths: [
      "/settings/browser",
      "/settings/devices",
      "/settings/snap-shot",
      "/settings/connections",
      "/settings/phone",
      "/settings/access",
      "/settings/secrets",
    ],
  },
  {
    heading: msg("More"),
    headingHidden: true,
    paths: ["/settings/maintenance", "/settings/labs", "/settings/stats", "/settings/about", "/settings/archived"],
  },
];

/** T3's menu pages in Rubato's groups and order. */
export function rubatoSettingsNavGroups(upstream: ReadonlyArray<SettingsNavGroup>): ReadonlyArray<SettingsNavGroup> {
  const present = upstream.flatMap((group) => group.paths);
  const placed = new Set<string>();
  const groups = RUBATO_GROUPS.map((group) => {
    const paths = present.filter((path) => group.paths.includes(path));
    paths.sort((a, b) => group.paths.indexOf(a) - group.paths.indexOf(b));
    for (const path of paths) placed.add(path);
    return { ...group, paths };
  });
  const unplaced = present.filter((path) => !placed.has(path));
  const last = groups.length - 1;
  groups[last] = { ...groups[last]!, paths: [...groups[last]!.paths, ...unplaced] };
  return groups.filter((group) => group.paths.length > 0);
}
