// Migration-time inventory only. Never imports or executes the legacy runtime.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (source) => createHash("sha256").update(source).digest("hex");

function arraySource(source, name) {
  const match = source.match(new RegExp(`(?:export )?const ${name} = (\\[[\\s\\S]*?\\]);`));
  if (!match) throw new Error(`Unrecognized Senpi registration array: ${name}`);
  return match[1];
}

export function scanBuiltinSources({ index, loader, defaults }) {
  const imports = new Map([...index.matchAll(/import (\w+) from "(\.[^"]+)";/g)].map((match) => [match[1], match[2]]));
  const body = arraySource(index, "builtinExtensions").replace(/\/\/[^\n]*/g, "");
  const rows = [...body.matchAll(/\{ id: "([^"]+)", factory: (\w+) \}/g)];
  if (rows.length !== [...body.matchAll(/\bid\s*:/g)].length || rows.length === 0) {
    throw new Error("Unrecognized builtin factory; inventory cannot silently omit it");
  }
  const disabled = new Set([
    ...JSON.parse(arraySource(defaults, "DISABLED_OAUTH_EXTENSIONS")),
    ...JSON.parse(arraySource(defaults, "DISABLED_WEB_SEARCH_EXTENSIONS")),
  ]);
  const entries = rows.map((match) => {
    const path = imports.get(match[2]);
    if (!path) throw new Error(`Unresolved builtin factory: ${match[2]}`);
    return {
      id: match[1],
      registration: "builtin",
      source: `dist/core/extensions/builtin/${path.slice(2)}`,
      defaultPolicy: disabled.has(match[1]) ? "disabled-by-rubato" : "registered-subject-to-settings",
      status: "pending-contract-and-parity",
    };
  });
  const globals = JSON.parse(arraySource(index, "globalDefaultExtensionIds"));
  const bundled = arraySource(loader, "bundledBuiltinExtensions");
  const bundledIds = [...bundled.matchAll(/\bid: "([^"]+)"/g)].map((match) => match[1]);
  if (bundledIds.length !== 1 || bundledIds[0] !== "codemode" || !bundled.includes("@code-yeongyu/senpi-codemode")) {
    throw new Error("Bundled extension registration changed; update its source mapping explicitly");
  }
  entries.push({ id: "codemode", registration: "bundled-package", source: "@code-yeongyu/senpi-codemode", defaultPolicy: "registered-subject-to-settings", status: "pending-contract-and-parity" });
  for (const id of globals) {
    if (typeof id !== "string") throw new Error("Unrecognized global extension id");
    entries.push({ id, registration: "generated-global-extension", source: `dist/core/extensions/builtin/${id}.js`, defaultPolicy: "generated-subject-to-extension-selection", status: "pending-contract-and-parity" });
  }
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Duplicate builtin inventory id");
  for (const id of disabled) {
    if (!entries.some((entry) => entry.id === id)) throw new Error(`Rubato disabled policy refers to an unknown builtin: ${id}`);
  }
  return {
    schemaVersion: 1,
    scope: "builtin-registration-only-not-all-product-features",
    sources: { indexSha256: hash(index), loaderSha256: hash(loader), rubatoDefaultsSha256: hash(defaults) },
    entries,
  };
}

export function scanSenpiBuiltins({ senpiRoot, rubatoRoot }) {
  if (!senpiRoot || !rubatoRoot) throw new Error("Explicit Senpi source and Rubato source roots are required");
  const manifest = JSON.parse(readFileSync(join(senpiRoot, "package.json"), "utf8"));
  if (manifest.name !== "@code-yeongyu/senpi" || manifest.version !== "2026.9.4-3") throw new Error("Unexpected Senpi baseline; re-audit registration syntax and policy");
  const result = scanBuiltinSources({
    index: readFileSync(join(senpiRoot, "dist/core/extensions/builtin/index.js"), "utf8"),
    loader: readFileSync(join(senpiRoot, "dist/core/resource-loader.js"), "utf8"),
    defaults: readFileSync(join(rubatoRoot, "harness/rubato-pi/src/session-defaults.mjs"), "utf8"),
  });
  return { ...result, baseline: { name: manifest.name, version: manifest.version } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [senpiRoot, rubatoRoot] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(scanSenpiBuiltins({ senpiRoot, rubatoRoot }), null, 2)}\n`);
}
