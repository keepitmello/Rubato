import { fileURLToPath } from "node:url";
import { replaceOnce } from "./replace-once.mjs";

export function rubatoCodemodePaths() {
  return {
    index: fileURLToPath(new URL("../codemode/index.ts", import.meta.url)),
    notifier: fileURLToPath(new URL("../codemode/extension/eval-notifier.ts", import.meta.url)),
  };
}

export function isRubatoCodemodeEntry(extensionPath) {
  return extensionPath.endsWith("/senpi-codemode/src/index.ts")
    || extensionPath.endsWith("\\senpi-codemode\\src\\index.ts");
}

/**
 * Load the in-repo patched factory while keeping jiti's parent filename on the
 * vendor entry so remaining relative imports resolve inside the vendor package.
 */
export async function importRubatoCodemode(importer, extensionPath, paths = rubatoCodemodePaths()) {
  const { readFileSync } = await import("node:fs");
  const loaded = await Promise.resolve(importer.evalModule(readFileSync(paths.index, "utf8"), {
    filename: extensionPath,
    async: true,
  }));
  return loaded?.default ?? loaded;
}

/**
 * Redirect senpi-codemode's jiti load onto the in-repo patched copies.
 * Needles sit in regions #29 does not touch, so this applies pre-flip and post-flip.
 */
export function injectCodemodeRedirect(source, paths = rubatoCodemodePaths()) {
  const indexLiteral = JSON.stringify(paths.index);
  const notifierLiteral = JSON.stringify(paths.notifier);
  let next = source;
  next = replaceOnce(
    next,
    "                : { alias: getAliases() }),",
    `                : { alias: { ...getAliases(), "./extension/eval-notifier.ts": ${notifierLiteral} } }),`,
    "codemode jiti notifier alias",
  );
  next = replaceOnce(
    next,
    "    const module = await importer.import(extensionPath, { default: true });",
    `    const module = await (async () => {
        if (extensionPath.endsWith("/senpi-codemode/src/index.ts") || extensionPath.endsWith("\\senpi-codemode\\src\\index.ts")) {
            const loaded = await Promise.resolve(importer.evalModule(fs.readFileSync(${indexLiteral}, "utf8"), { filename: extensionPath, async: true }));
            return loaded?.default ?? loaded;
        }
        return importer.import(extensionPath, { default: true });
    })();`,
    "codemode jiti entry evalModule",
  );
  return next;
}
