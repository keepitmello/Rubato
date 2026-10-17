// Rubato (window-material-edits.mjs): hands the web app the material the main
// window was made with. The main process passes it as an additional argument;
// its format is WINDOW_MATERIAL_ARGUMENT in packages/contracts/src/rubatoWindowMaterial.ts.
// Nothing is imported from there: the sandboxed preload bundle stays small.
import { contextBridge } from "electron";

const WINDOW_MATERIAL_ARGUMENT = "--rubato-window-material=";

// oxlint-disable-next-line t3code/no-global-process-runtime -- the sandboxed preload sees its additionalArguments in process.argv.
const windowMaterialArgument = process.argv.find((value) =>
  value.startsWith(WINDOW_MATERIAL_ARGUMENT),
);

if (windowMaterialArgument !== undefined) {
  contextBridge.exposeInMainWorld("rubatoWindowMaterial", { argument: windowMaterialArgument });
  // The first frame already paints for the window's material; the app's own
  // settings sync takes over once they load.
  const active = windowMaterialArgument.slice(WINDOW_MATERIAL_ARGUMENT.length).split(";")[0] ?? "";
  window.addEventListener(
    "DOMContentLoaded",
    () => {
      document.documentElement.dataset.windowMaterial = active;
    },
    { once: true },
  );
}
