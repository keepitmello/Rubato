import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripChangelog, withNoChangelog } from "../../src/no-changelog.mjs";
import { senpiDir } from "../../src/engine-paths.mjs";

const senpi = join(senpiDir, "dist");

test("strips the changelog command and startup dump from pinned senpi", () => {
  const slash = readFileSync(join(senpi, "core/slash-commands.js"), "utf8");
  const interactive = readFileSync(join(senpi, "modes/interactive/interactive-mode.js"), "utf8");
  const settings = readFileSync(join(senpi, "modes/interactive/components/settings-selector.js"), "utf8");
  const nextSlash = stripChangelog(slash, "slash-commands.js");
  const nextInteractive = stripChangelog(interactive, "interactive-mode.js");
  const nextSettings = stripChangelog(settings, "settings-selector.js");
  assert.match(slash, /name: "changelog"/);
  assert.doesNotMatch(nextSlash, /name: "changelog"/);
  assert.match(interactive, /text === "\/changelog"/);
  assert.doesNotMatch(nextInteractive, /text === "\/changelog"/);
  assert.match(nextInteractive, /getChangelogForDisplay\(\) \{ return undefined;/);
  assert.match(nextInteractive, /handleChangelogCommand\(\) \{ return;/);
  assert.match(settings, /collapse-changelog/);
  assert.doesNotMatch(nextSettings, /collapse-changelog/);
});

test("launch env loads the changelog stripper once", () => {
  const first = withNoChangelog({});
  const again = withNoChangelog(first);
  assert.match(first.NODE_OPTIONS, /no-changelog-register/);
  assert.equal(again.NODE_OPTIONS, first.NODE_OPTIONS);
});
