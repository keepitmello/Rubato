// The Rubato iPhone app's part of the T3 integration: T3's apps/mobile under Rubato's
// name, its shell and model logos, plus the companion and push work it carries. Each
// owner keeps one file here; apply.mjs merges them like every other *-edits.mjs.
//
//   shell-edits.mjs      app name/bundle id, T3 cloud off, tabs, routes, model logos
//   deps-edits.mjs       packages the app adds (package.json + generated lockfile edits)
//   push-edits.mjs       phone push registration and the Mac's /rubato/push route
//   companion-edits.mjs  companion rooms and calls
//
// Two files must never edit one file at the same anchor: apply.mjs undoes an edit by
// finding addition+anchor, and a second addition in between hides the first.
import { shellEdits, shellOverlays } from './shell-edits.mjs';
import { depsEdits, depsOverlays } from './deps-edits.mjs';
import { mobilePushEdits, mobilePushOverlays } from './push-edits.mjs';
import { mobileCompanionEdits, mobileCompanionOverlays } from './companion-edits.mjs';

const tables = [
  [shellEdits, shellOverlays],
  [depsEdits, depsOverlays],
  [mobilePushEdits, mobilePushOverlays],
  [mobileCompanionEdits, mobileCompanionOverlays],
];

export const mobileOverlays = tables.flatMap(([, overlays]) => overlays);
export const mobileEdits = {};
for (const [edits] of tables)
  for (const [relative, changes] of Object.entries(edits))
    mobileEdits[relative] = [...(mobileEdits[relative] ?? []), ...changes];
