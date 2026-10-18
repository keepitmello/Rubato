import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = process.env.T3_SOURCE;
const overlay = new URL("../overlay/apps/", import.meta.url);
function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "rb-account-labels-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(join(source, "apps/web/node_modules"), join(root, "node_modules"), "dir");
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, readFileSync(new URL(`web/src/${file}`, overlay)));
  }
  return root;
}

test("settings label and sort main, sub and sub2 without guessing unknown accounts",
  { skip: !source }, (t) => {
    const root = fixture(t, ["rubatoAccountLabel.ts"]);
    const code = `
      import { rubatoAccountLabel, rubatoAccountOrder } from ${JSON.stringify(join(root, "rubatoAccountLabel.ts"))};
      console.log(JSON.stringify({
        labels: ["", "-sub", "-sub2", null].map(rubatoAccountLabel),
        order: ["-sub2", "-sub", "", null].toSorted((a,b)=>rubatoAccountOrder(a)-rubatoAccountOrder(b)),
      }));
    `;
    const result = JSON.parse(execFileSync("bun", ["-e", code], { cwd: root, encoding: "utf8" }));
    assert.deepEqual(result.labels, ["Main account", "Sub account", "Sub account 2", null]);
    assert.deepEqual(result.order, ["", "-sub", "-sub2", null]);
  });

test("settings account roles use Korean interface text", { skip: !source }, (t) => {
  const root = fixture(t, ["rubatoI18n.ts", "rubatoI18n.ko.json"]);
  const code = `
    import {createUiTranslator} from ${JSON.stringify(join(root, "rubatoI18n.ts"))};
    import dictionary from ${JSON.stringify(join(root, "rubatoI18n.ko.json"))};
    const t = createUiTranslator(dictionary);
    console.log(JSON.stringify(["Main account","Sub account","Sub account 2"].map(x=>t.lookup(x))));
  `;
  const result = JSON.parse(execFileSync("bun", ["-e", code], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(result, ["메인 계정", "서브 계정", "서브 계정 2"]);
});
