var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { lazyApi } from "./lazy.js";
/**
 * Loads the cursor-agent implementation through a variable specifier so
 * bundlers (browser smoke, Bun compile) cannot follow the import into the
 * Node-only HTTP/2 transport. The `.ts`/`.js` rewrite keeps the trick working
 * from both source and built output.
 */
const importNodeOnlyApi = (specifier) => {
    const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
    return import(__rewriteRelativeImportExtension(runtimeSpecifier));
};
let cursorAgentModuleOverride;
/**
 * Overrides the dynamically imported cursor-agent implementation. Used by the
 * Bun binary build, where the variable-specifier import cannot be bundled;
 * the build registers a statically imported module instead.
 */
export function setCursorAgentProviderModule(module) {
    cursorAgentModuleOverride = module;
}
/** Loads the Node-only cursor-agent module (stream + model discovery). */
export const loadCursorAgentModule = async () => cursorAgentModuleOverride ?? (await importNodeOnlyApi("./cursor-agent.ts"));
/** Lazy wrapper: keeps the Node-only Cursor agent transport out of eager import graphs. */
export const cursorAgentApi = () => lazyApi(loadCursorAgentModule);
//# sourceMappingURL=cursor-agent.lazy.js.map