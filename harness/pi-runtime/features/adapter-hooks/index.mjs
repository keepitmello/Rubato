import { installEvalSearchGuard } from "./eval-search-guard.mjs";
import { installMeasurementHooks } from "./measurement-recorder.mjs";
import { installToolOutputPreviews } from "./tool-output.mjs";

export function createAdapterHookFactories() {
  return [
    { name: "rubato-eval-search-guard", factory: (pi) => installEvalSearchGuard(pi) },
    { name: "rubato-measurement", factory: (pi) => installMeasurementHooks(pi) },
    { name: "rubato-tool-output", factory: (pi) => installToolOutputPreviews(pi) },
  ];
}

export { installEvalSearchGuard } from "./eval-search-guard.mjs";
export { installMeasurementHooks } from "./measurement-recorder.mjs";
export { installToolOutputPreviews } from "./tool-output.mjs";
export default createAdapterHookFactories;
