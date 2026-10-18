import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { providerEdits } from "../provider-edits.mjs";
import { PRODUCT_MODEL_ORDER } from "../../../packages/model-core/src/product-model-catalog.mjs";

function patched(text, edits) {
  for (const [anchor, addition, mode] of edits) {
    assert.equal(text.split(anchor).length, 2, `unambiguous upstream anchor: ${anchor}`);
    text = text.replace(anchor, mode === "replace" ? addition : addition + anchor);
  }
  return text;
}

test("manual account rows remain last after saved ordering, favorites and search", { skip: !process.env.T3_SOURCE }, () => {
  const source = process.env.T3_SOURCE;
  const pin = JSON.parse(readFileSync(new URL("../upstream.json", import.meta.url), "utf8"));
  const original = (file) => execFileSync("git", ["-C", source, "show", `${pin.upstreamCommit}:${file}`], { encoding: "utf8" });
  const scratch = mkdtempSync(join(tmpdir(), "rb-model-order-"));
  const baseId = `anthropic/${PRODUCT_MODEL_ORDER.anthropic[1]}`;
  try {
    writeFileSync(join(scratch, "modelOrdering.ts"), patched(original("apps/web/src/modelOrdering.ts"), providerEdits["apps/web/src/modelOrdering.ts"]));
    writeFileSync(join(scratch, "rubatoAccountModelOrder.ts"), readFileSync(new URL("../overlay/apps/web/src/rubatoAccountModelOrder.ts", import.meta.url)));
    symlinkSync(join(source, "apps/web/node_modules"), join(scratch, "node_modules"), "dir");
    const result = execFileSync("bun", ["-e", `
      import { sortModelsForProviderInstance, sortProviderModelItems } from ${JSON.stringify(join(scratch, "modelOrdering.ts"))};
      const base = { slug: ${JSON.stringify(baseId)}, instanceId: "rubato" };
      const sub = { slug: base.slug + "-sub", instanceId: "rubato" };
      console.log(JSON.stringify([
        sortModelsForProviderInstance([sub, base], { modelOrder: [sub.slug, base.slug], favoriteModels: [sub.slug], groupFavorites: true }).map(x => x.slug),
        sortProviderModelItems([sub, base], { favoriteModelKeys: ["rubato:" + sub.slug], groupFavorites: true }).map(x => x.slug),
      ]));
    `], { encoding: "utf8" });
    const expected = [baseId, `${baseId}-sub`];
    assert.deepEqual(JSON.parse(result), [expected, expected]);
    const search = patched(original("apps/web/src/components/chat/ModelPickerContent.tsx"), providerEdits["apps/web/src/components/chat/ModelPickerContent.tsx"]);
    assert.match(search, /return ranked\.toSorted\(\(a, b\) => rubatoAccountModelRank\(a\.slug\) - rubatoAccountModelRank\(b\.slug\)\)/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
