import { createHistorySearchExtension } from "./history-search/index.mjs";
import { createHelpExtension } from "./help/index.mjs";
import { createDiffExtension } from "./diff/index.mjs";
import { createFilesExtension } from "./files/index.mjs";
import { createRedrawsExtension } from "./redraws/index.mjs";

export const USER_COMMAND_SESSION_FACTORY_NAMES = Object.freeze([
  "rubato-history-search",
  "rubato-help",
  "rubato-diff",
  "rubato-files",
  "rubato-redraws",
]);

export function createUserCommandSessionFactories(options = {}) {
  return [
    { name: "rubato-history-search", factory: createHistorySearchExtension(options) },
    { name: "rubato-help", factory: createHelpExtension(options) },
    { name: "rubato-diff", factory: createDiffExtension(options) },
    { name: "rubato-files", factory: createFilesExtension(options) },
    { name: "rubato-redraws", factory: createRedrawsExtension(options) },
  ];
}

export { createHistorySearchExtension } from "./history-search/index.mjs";
export { createHelpExtension } from "./help/index.mjs";
export { createDiffExtension } from "./diff/index.mjs";
export { createFilesExtension } from "./files/index.mjs";
export { createRedrawsExtension } from "./redraws/index.mjs";

export default createUserCommandSessionFactories;
