import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_MODEL_ORDER } from "../../../packages/model-core/src/product-model-catalog.mjs";
import { usageLimitsEdits } from "../usage-limits-edits.mjs";

const source = process.env.T3_SOURCE;
const overlay = new URL("../overlay/apps/", import.meta.url);
function fixture(t, app, files) {
  const root = mkdtempSync(join(tmpdir(), "rb-account-labels-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(join(source, `apps/${app}/node_modules`), join(root, "node_modules"), "dir");
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, readFileSync(new URL(`${app}/src/${file}`, overlay)));
  }
  return root;
}

test("the conversation badge shows the assigned account, not the model suffix; unknown and other providers show nothing",
  { skip: !source }, (t) => {
    const root = fixture(t, "web", ["rubatoAccountLabel.ts", "components/chat/RubatoSessionAccountBadge.tsx"]);
    const model = `anthropic/${PRODUCT_MODEL_ORDER.anthropic[0]}`;
    const code = `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { RubatoSessionAccountBadge } from ${JSON.stringify(join(root, "components/chat/RubatoSessionAccountBadge.tsx"))};
      import { rubatoAccountLabel, rubatoAccountOrder } from ${JSON.stringify(join(root, "rubatoAccountLabel.ts"))};
      const draw = (account, model) => renderToStaticMarkup(React.createElement(RubatoSessionAccountBadge, { account, model }));
      console.log(JSON.stringify({
        automaticSub: draw({provider:"anthropic",name:"default",modelSuffix:"-sub"}, ${JSON.stringify(model)}),
        fixedMain: draw({provider:"anthropic",name:"setup-token",modelSuffix:""}, ${JSON.stringify(`${model}-sub`)}),
        unknown: draw(null, ${JSON.stringify(model)}),
        otherProvider: draw({provider:"anthropic",name:"default",modelSuffix:"-sub"}, "other/model"),
        labels: ["", "-sub", "-sub2", null].map(rubatoAccountLabel),
        order: ["-sub2", "-sub", "", null].toSorted((a,b)=>rubatoAccountOrder(a)-rubatoAccountOrder(b)),
      }));
    `;
    const result = JSON.parse(execFileSync("bun", ["-e", code], { cwd: root, encoding: "utf8" }));
    assert.match(result.automaticSub, /Sub account/);
    assert.match(result.automaticSub, /\[sub\]/);
    assert.match(result.automaticSub, /data-rubato-session-account="default"/);
    assert.match(result.fixedMain, /Main account/);
    assert.doesNotMatch(result.fixedMain, /Sub account/);
    assert.equal(result.unknown, "");
    assert.equal(result.otherProvider, "");
    assert.deepEqual(result.labels, ["Main account", "Sub account", "Sub account 2", null]);
    assert.deepEqual(result.order, ["", "-sub", "-sub2", null]);
  });

test("usage rows identify main and sub accounts even when the internal default account is the sub",
  { skip: !source }, (t) => {
    const root = fixture(t, "server", ["usage/RubatoUsageLimits.ts"]);
    const code = `
      import { rubatoUsageAccounts } from ${JSON.stringify(join(root, "usage/RubatoUsageLimits.ts"))};
      const row = (account, modelSuffix) => ({
        provider:"anthropic", account, modelSuffix,
        usageLimits:{checkedAt:"2026-10-18T00:00:00Z", windows:[]},
      });
      console.log(JSON.stringify(rubatoUsageAccounts({accounts:[
        row("default","-sub"),row("setup-token",""),row("third","-sub2"),row("legacy",null),
      ]}).map(x=>x.id)));
    `;
    const result = JSON.parse(execFileSync("bun", ["-e", code], { cwd: root, encoding: "utf8" }));
    assert.deepEqual(result, [
      "Claude · Sub account [sub]", "Claude · Main account", "Claude · Sub account 2 [sub2]", "Claude · legacy",
    ]);
  });

test("usage account roles stay visible beside signed-in email addresses", { skip: !source }, (t) => {
  const root = fixture(t, "web", []);
  const pin = JSON.parse(readFileSync(new URL("../upstream.json", import.meta.url), "utf8"));
  const relative = "packages/shared/src/usageLimits.ts";
  let text = execFileSync("git", ["-C", source, "show", `${pin.upstreamCommit}:${relative}`], { encoding: "utf8" });
  for (const [anchor, addition] of usageLimitsEdits[relative]) {
    assert.equal(text.split(anchor).length, 2);
    text = text.replace(anchor, addition);
  }
  writeFileSync(join(root, "usageMath.ts"), text);
  const code = `
    import {collectLimitAccounts} from ${JSON.stringify(join(root, "usageMath.ts"))};
    const account = {id:"Claude · Sub account [sub]", driver:"claudeAgent", email:"sub@example.com",
      usageLimits:{checkedAt:"2026-10-18T00:00:00Z",windows:[{id:"seven_day",kind:"weekly",label:"Weekly",usedPercent:10}]}};
    const draw = kind => collectLimitAccounts(new Map([["env",{entry:{target:{label:"Local"}},serverConfig:{
      providers:[],usageLimitSources:[{id:"source",label:"Source",kind,accounts:[account]}]
    }}]]));
    console.log(JSON.stringify({rubato:draw("rubato"),other:draw("cliProxyApi")}));
  `;
  const result = JSON.parse(execFileSync("bun", ["-e", code], { cwd: root, encoding: "utf8" }));
  assert.equal(result.rubato[0].displayName, "Claude · Sub account [sub]");
  assert.equal(result.rubato[0].email, "sub@example.com");
  assert.equal(result.other[0].displayName, null, "other sources keep their email-chip presentation");
});

test("account roles and the fixed-session tooltip use Korean interface text", { skip: !source }, (t) => {
  const root = fixture(t, "web", ["rubatoI18n.ts", "rubatoI18n.ko.json"]);
  const code = `
    import {createUiTranslator} from ${JSON.stringify(join(root, "rubatoI18n.ts"))};
    import dictionary from ${JSON.stringify(join(root, "rubatoI18n.ko.json"))};
    const t = createUiTranslator(dictionary);
    console.log(JSON.stringify(["Main account","Sub account","Sub account 2","default · Fixed for this session",
      "Claude · Sub account [sub]"].map(x=>t.lookup(x))));
  `;
  const result = JSON.parse(execFileSync("bun", ["-e", code], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(result, ["메인 계정", "서브 계정", "서브 계정 2", "default · 이 세션에서 고정", "Claude · 서브 계정 [sub]"]);
});
