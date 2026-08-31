import { replaceOnce } from "./replace-once.mjs";

export function isExtensionsLoaderUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/loader.js");
}

export function isExtensionsRunnerUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/runner.js");
}

export function injectExtensionsLoader(source) {
  let next = source;
  next = replaceOnce(
    next,
    "        setSessionFastMode: notInitialized,\n        flagValues: new Map(),\n        pendingProviderRegistrations: [],",
    "        setSessionFastMode: notInitialized,\n        flagValues: new Map(),\n        getInteractiveControl: () => undefined,\n        pendingProviderRegistrations: [],",
    "extensions loader runtime getInteractiveControl",
  );
  next = replaceOnce(
    next,
    "            return runtime.getCommands();\n        },\n        setModel(model) {",
    `            return runtime.getCommands();
        },
        getInteractiveControl() {
            runtime.assertActive();
            return runtime.getInteractiveControl();
        },
        setModel(model) {`,
    "extensions loader api getInteractiveControl",
  );
  return next;
}

export function injectExtensionsRunner(source) {
  return replaceOnce(
    source,
    "            this.modelRegistry.unregisterProvider(name);\n        };\n    }\n    bindCommandContext(actions) {",
    `            this.modelRegistry.unregisterProvider(name);
        };
    }
    setInteractiveControl(surface) {
        this.runtime.getInteractiveControl = () => surface;
    }
    bindCommandContext(actions) {`,
    "extensions runner setInteractiveControl",
  );
}
