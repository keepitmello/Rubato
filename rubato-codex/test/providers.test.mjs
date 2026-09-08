import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverProviderCatalog,
  makeProviderPolicy,
  parseProviderArgument,
  resolveProviderSelection,
} from "../scripts/providers.mjs";

test("provider arguments are deterministic and none means native Codex only", () => {
  assert.deepEqual(parseProviderArgument("none"), []);
  assert.deepEqual(parseProviderArgument("xai,cursor,xai"), ["cursor", "xai"]);
  assert.throws(() => parseProviderArgument("xai/bad"), /invalid provider id/);
});

test("OpenCodex catalog discovery exposes identifiers but no provider configuration or auth", async () => {
  const home = await mkdtemp(join(tmpdir(), "rubato-provider-catalog-"));
  await writeFile(join(home, "config.json"), JSON.stringify({
    port: 10100,
    providers: {
      openai: { authMode: "oauth", secret: "must-not-leak" },
      xai: { authMode: "oauth", accessToken: "must-not-leak", models: ["grok-4.6", 42, " bad"] },
      cursor: { authMode: "oauth", models: ["gpt-5.6-sol", "gpt-5.6-terra"], selectedModels: ["gpt-5.6-sol", null] },
    },
    disabledModels: ["xai/grok-disabled", false],
  }));
  const catalog = await discoverProviderCatalog({ opencodexHome: home });
  assert.equal(catalog.status, "available");
  assert.equal(catalog.port, 10100);
  assert.deepEqual(catalog.providers.map((provider) => provider.id), ["cursor", "xai"]);
  assert.deepEqual(catalog.providers[0].models, ["cursor/gpt-5.6-sol"]);
  assert.deepEqual(catalog.providers[1].models, ["xai/grok-4.6"]);
  assert.doesNotMatch(JSON.stringify(catalog), /secret|accessToken|must-not-leak/);
});

test("selection supports subset, preserves updates, and fails closed for unavailable explicit providers", async () => {
  const catalog = {
    status: "available",
    configPath: "/fixture/config.json",
    providers: [{ id: "cursor", displayName: "Cursor", source: "opencodex" }, { id: "xai", displayName: "xAI", source: "opencodex" }],
  };
  assert.deepEqual(
    await resolveProviderSelection({ requested: "xai", catalog, interactive: false }),
    { selected: ["xai"], source: "explicit" },
  );
  assert.deepEqual(
    await resolveProviderSelection({ previous: ["xai"], catalog: { status: "missing", providers: [] }, interactive: false }),
    { selected: ["xai"], source: "preserved" },
  );
  await assert.rejects(
    resolveProviderSelection({ requested: "anthropic", catalog, interactive: false }),
    /not configured in OpenCodex.*anthropic/,
  );
  await assert.rejects(
    resolveProviderSelection({ requested: "openai", catalog, interactive: false }),
    /not configured in OpenCodex.*openai/,
  );
});

test("interactive first install can choose multiple catalog entries", async () => {
  const catalog = {
    status: "available",
    configPath: "/fixture/config.json",
    providers: [{ id: "cursor" }, { id: "xai" }],
  };
  const selected = await resolveProviderSelection({
    catalog,
    interactive: true,
    prompt: async () => ["xai", "cursor"],
  });
  assert.deepEqual(selected, { selected: ["cursor", "xai"], source: "interactive" });
  const policy = JSON.parse(makeProviderPolicy(catalog, selected.selected));
  assert.deepEqual(policy.selectedProviders, ["cursor", "xai"]);
});

test("missing or malformed OpenCodex config defaults safely to native Codex only", async () => {
  const missingHome = await mkdtemp(join(tmpdir(), "rubato-provider-missing-"));
  const missing = await discoverProviderCatalog({ opencodexHome: missingHome });
  assert.equal(missing.status, "missing");
  assert.deepEqual(
    await resolveProviderSelection({ catalog: missing, interactive: false }),
    { selected: [], source: "default" },
  );
  await mkdir(join(missingHome, "broken"));
  await writeFile(join(missingHome, "config.json"), "not-json");
  const malformed = await discoverProviderCatalog({ opencodexHome: missingHome });
  assert.equal(malformed.status, "unreadable");
  assert.deepEqual(await resolveProviderSelection({ catalog: malformed, interactive: false }), { selected: [], source: "default" });
});
