import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// The sidebar looks as on T3 v0.1.0 (sidebar-look-edits.mjs), read from an applied tree.
const applied = (relative) => readFile(path.join(process.env.T3_SOURCE, relative), 'utf8');
const skip = { skip: !process.env.T3_SOURCE };

test('a card keeps three lines with the pin beside the time', skip, async () => {
  const row = await applied('apps/web/src/components/sidebar/SidebarThreadRow.tsx');
  const card = row.slice(row.lastIndexOf('data-testid="sidebar-row-card"'));
  // One height for every card; the empty third line still carries the model logo.
  assert.match(card, /"relative z-10 h-\[4\.875rem\]/);
  assert.doesNotMatch(card, /metaLineEmpty && "h-auto"/);
  assert.match(card, /\{rubatoCardMetaLine\}/);
  assert.doesNotMatch(card, /\{titleLineIcons\}/);
  assert.match(row, /const rubatoCardMetaLine = metaLine \?\? \(/);
  // Project name first, then the pin, then the status slot.
  const name = card.indexOf('{props.projectDisplayName}');
  const pin = card.indexOf('{pinIndicator}');
  const status = card.indexOf('group/sidebar-status-slot');
  assert.ok(name > 0 && name < pin && pin < status, 'project name, pin, status in that order');
  assert.match(card, /shouldRecede \? "font-normal" : "font-medium"/);
  // The branch line is the faint gray.
  assert.match(row, /<span className="flex min-w-0 flex-1 text-muted-foreground\/40">\n\s+<MiddleTruncate value=\{checkoutThread\.branch\}/);
});

test('settled rows fade to 70% and the open row has no light-theme rim', skip, async () => {
  const row = await applied('apps/web/src/components/sidebar/SidebarThreadRow.tsx');
  assert.match(row, /:text-secondary-label\/70",/);
  assert.doesNotMatch(row, /light:ring-sidebar-border\/70/);
});

test('a folded shelf header reads "Settled (4)" with v0.1.0 tones and an upward chevron', skip, async () => {
  const markers = await applied('apps/web/src/components/sidebar/SidebarListMarkers.tsx');
  assert.match(markers, /\{props\.toggle\.expanded \? props\.label : `\$\{props\.label\} \(\$\{props\.count\}\)`\}/);
  assert.doesNotMatch(markers, /accessory=\{<span className="font-normal tabular-nums">\{props\.count\}/);
  assert.match(markers, /shelf === "snoozed"\n\s+\? "info"/);
  const header = await applied('apps/web/src/components/ui/collapsible-section-header.tsx');
  assert.match(header, /muted: \{ label: "text-sidebar-muted-foreground\/60", line: "bg-sidebar-border\/60" \}/);
  assert.match(header, /info: \{ label: "text-blue-600 dark:text-blue-400"/);
  assert.match(header, /!expanded && "rotate-180"/);
});

test('the undo notice is a card at the top of the footer, which pads 4px top and bottom', skip, async () => {
  const chrome = await applied('apps/web/src/components/sidebar/SidebarChrome.tsx');
  assert.match(chrome, /<SidebarFooter>\n\s+<RubatoThreadUndoNotice \/>/);
  assert.doesNotMatch(chrome, /<SidebarThreadUndoNotice \/>/);
  const notice = await applied('apps/web/src/components/sidebar/RubatoThreadUndoNotice.tsx');
  assert.match(notice, /<Alert role="status" variant="sidebar">/);
  const sidebar = await applied('apps/web/src/components/ui/sidebar.tsx');
  assert.match(sidebar, /"flex flex-col gap-2 px-\[var\(--sidebar-content-inset\)\] py-1",/);
});

test('the narrow-window project picker keeps Rubato\'s order instead of lifting pinned projects', skip, async () => {
  const sidebar = await applied('apps/web/src/components/Sidebar.tsx');
  const lookups = sidebar.slice(sidebar.indexOf('const projectScopeItems = ['), sidebar.indexOf('return {', sidebar.indexOf('const projectScopeItems = [')));
  assert.match(lookups, /\.\.\.projectGroups\.filter\(\(group\) => !group\.archived\)\.map\(/);
  assert.doesNotMatch(lookups, /pickableProjectGroups/);
});

test('the narrow-window drawer and project picker keep v0.1.0\'s size and gear', skip, async () => {
  const ui = await applied('apps/web/src/components/ui/sidebar.tsx');
  assert.match(ui, /const SIDEBAR_WIDTH_MOBILE = "auto";/);
  const sidebar = await applied('apps/web/src/components/Sidebar.tsx');
  assert.match(sidebar, /anchor=\{rubatoSearchFieldRef\}\n\s+collisionAvoidance=\{\{ side: "flip", align: "shift" \}\}\n\s+className="max-w-\[min\(18rem,var\(--available-width\)\)\] overflow-hidden"/);
  assert.match(sidebar, /searchFieldRef=\{rubatoSearchFieldRef\}/);
  assert.doesNotMatch(sidebar, /<ProjectRowActions/);
  assert.match(sidebar, /<Button\n\s+className="ml-auto"\n\s+size="icon-xs"/);
  const header = await applied('apps/web/src/components/sidebar/SidebarThreadHeader.tsx');
  assert.match(header, /<div ref=\{searchFieldRef\} className="flex h-8 min-w-0 flex-1/);
});
