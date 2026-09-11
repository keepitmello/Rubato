import { parseModelPattern } from "../host/model-resolver.mjs";
import { resolveVisionModel } from "./model-selector.js";
import { loadLookAtEnabled } from "./settings.js";
const MENU = ["Show current chain", "Edit chain", "Reset session override", "Toggle look_at"];
const USAGE = "Usage: /lookat <model1> [model2 ...]";
export function registerLookAtCommand(pi, deps) {
    pi.registerCommand("lookat", {
        description: "View and manage the current-session look_at vision model chain.",
        argumentHint: "[model1 [model2 ...]]",
        handler: async (rawArgs, rawContext) => {
            const ctx = deps.adaptContext(rawContext);
            const entries = parseEntries(rawArgs);
            if (entries.length === 0) {
                await runMenu(ctx, deps);
                return;
            }
            saveChain(ctx, entries, deps);
        },
    });
}
async function runMenu(ctx, deps) {
    if (!ctx.hasUI) {
        ctx.ui.notify("look_at menu requires interactive UI. Use /lookat <model1> [model2 ...].", "error");
        return;
    }
    const choice = await ctx.ui.select(renderState(ctx, deps), [...MENU]);
    if (!choice)
        return;
    if (choice === "Show current chain") {
        ctx.ui.notify(renderState(ctx, deps));
        return;
    }
    if (choice === "Edit chain") {
        const input = await ctx.ui.input("look_at model chain", deps.loadChain(ctx).join(" "));
        if (input === undefined)
            return;
        const entries = parseEntries(input);
        if (entries.length === 0) {
            ctx.ui.notify(USAGE, "error");
            return;
        }
        saveChain(ctx, entries, deps);
        return;
    }
    if (choice === "Reset session override") {
        deps.store.setModels(undefined);
        deps.store.setEnabled(undefined);
        deps.resync(ctx);
        ctx.ui.notify("Reset look_at session override.");
        return;
    }
    const enabled = !loadLookAtEnabled(ctx, deps.store);
    deps.store.setEnabled(enabled);
    deps.resync(ctx);
    ctx.ui.notify(`look_at ${enabled ? "enabled" : "disabled"} for this session.`);
}
function saveChain(ctx, entries, deps) {
    const warnings = validateEntries(entries, ctx);
    if (warnings.length > 0)
        ctx.ui.notify(warnings.join("\n"), "warning");
    deps.store.setModels(entries);
    deps.resync(ctx);
    ctx.ui.notify("look_at model chain saved for this session.");
}
function validateEntries(entries, ctx) {
    const visionModels = ctx.modelRegistry.getAvailable().filter((model) => model.input.includes("image"));
    return entries.flatMap((entry) => {
        const parsed = parseModelPattern(entry, visionModels);
        if (!parsed.model)
            return [`No available image-capable model matches "${entry}"; saved for a future auth setup.`];
        return parsed.warning ? [parsed.warning] : [];
    });
}
function renderState(ctx, deps) {
    const chain = deps.loadChain(ctx);
    const available = ctx.modelRegistry.getAvailable();
    const entries = chain.length === 0 ? ["  (empty)"] : chain.map((entry) => `  ${entry} -> ${resolveEntry(entry, available)}`);
    return [
        `look_at: ${loadLookAtEnabled(ctx, deps.store) ? "enabled" : "disabled"}`,
        `Model chain (source: ${chainSource(ctx, deps.store)}):`,
        ...entries,
        "",
        "Note: this override is current-session only; permanent config is settings.json lookAt.models.",
    ].join("\n");
}
function resolveEntry(entry, available) {
    const visionModels = available.filter((model) => model.input.includes("image"));
    if (!parseModelPattern(entry, visionModels).model)
        return "unavailable";
    const resolved = resolveVisionModel([entry], available);
    return resolved ? `${resolved.model.provider}/${resolved.model.id}` : "unavailable";
}
function chainSource(ctx, store) {
    if (store.getOverride().models !== undefined)
        return "current-session override";
    if (ctx.getLookAtSettings().models !== undefined)
        return "settings.json lookAt.models";
    return "default";
}
function parseEntries(rawArgs) {
    return rawArgs.trim().split(/\s+/).filter(Boolean);
}
//# sourceMappingURL=commands.js.map
