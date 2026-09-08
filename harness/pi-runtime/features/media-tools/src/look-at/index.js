import { LOOK_AT_PARAMETERS, normalizeLookAtArgs, prepareLookAtArguments, validateLookAtArgs } from "./arguments.js";
import { registerLookAtCommand } from "./commands.js";
import { resolveVisionModel } from "./model-selector.js";
import { LOOK_AT_DESCRIPTION, LOOK_AT_PROMPT_SNIPPET } from "./prompts.js";
import { renderLookAtCall, renderLookAtResult } from "./render.js";
import { runLookAt } from "./runner.js";
import { createLookAtStore, loadLookAtChain, loadLookAtEnabled } from "./settings.js";
import { SettingsManager } from "../host-sdk.mjs";
const TOOL_NAME = "look_at";
export default function lookAtExtension(pi, host = {}) {
    const store = createLookAtStore();
    let settingsManager;
    function adaptContext(ctx) {
        settingsManager ??= host.createSettingsManager?.(ctx.cwd) ?? SettingsManager.create(ctx.cwd);
        const adapted = Object.create(ctx);
        Object.defineProperties(adapted, {
            getLookAtSettings: {
                value: () => {
                    const global = settingsManager.getGlobalSettings().lookAt;
                    const project = settingsManager.getProjectSettings().lookAt;
                    return {
                        enabled: project?.enabled ?? global?.enabled ?? true,
                        models: project?.models ?? global?.models,
                    };
                },
            },
            getImageSettings: {
                value: () => ({
                    autoResize: settingsManager.getImageAutoResize(),
                    blockImages: settingsManager.getBlockImages(),
                }),
            },
        });
        return adapted;
    }
    pi.registerTool({
        name: TOOL_NAME,
        label: "Look At",
        description: LOOK_AT_DESCRIPTION,
        promptSnippet: LOOK_AT_PROMPT_SNIPPET,
        parameters: LOOK_AT_PARAMETERS,
        prepareArguments: prepareLookAtArguments,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const normalized = normalizeLookAtArgs(params);
            const validationError = validateLookAtArgs(normalized);
            if (validationError)
                throw new Error(validationError);
            const result = await runLookAt(normalized, signal, adaptContext(ctx), store, { complete: host.complete });
            return {
                content: [{ type: "text", text: result.text }],
                details: { model: result.model, sources: result.sources, mimeTypes: result.mimeTypes },
            };
        },
        renderCall: renderLookAtCall,
        renderResult: renderLookAtResult,
    });
    function syncToolActivation(rawContext) {
        const ctx = adaptContext(rawContext);
        const active = pi.getActiveTools();
        const shouldBeActive = loadLookAtEnabled(ctx, store) &&
            ctx.model !== undefined &&
            !ctx.model.input.includes("image") &&
            resolveVisionModel(loadLookAtChain(ctx, store), ctx.modelRegistry.getAvailable()) !== undefined;
        const isActive = active.includes(TOOL_NAME);
        if (shouldBeActive && !isActive) {
            pi.setActiveTools([...active, TOOL_NAME]);
        }
        else if (!shouldBeActive && isActive) {
            pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
        }
    }
    pi.on("session_start", async (_event, ctx) => {
        syncToolActivation(ctx);
    });
    pi.on("model_select", async (_event, ctx) => {
        syncToolActivation(ctx);
    });
    registerLookAtCommand(pi, {
        store,
        adaptContext,
        loadChain: (ctx) => loadLookAtChain(ctx, store),
        resync: (ctx) => syncToolActivation(ctx),
    });
}
//# sourceMappingURL=index.js.map
