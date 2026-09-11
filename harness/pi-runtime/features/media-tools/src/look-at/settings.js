import { DEFAULT_LOOK_AT_CHAIN } from "./model-selector.js";
export function createLookAtStore() {
    let override = {};
    return {
        getOverride: () => override,
        setModels: (models) => {
            override = { ...override, models };
        },
        setEnabled: (enabled) => {
            override = { ...override, enabled };
        },
    };
}
export function loadLookAtChain(ctx, store) {
    return store.getOverride().models ?? ctx.getLookAtSettings().models ?? [...DEFAULT_LOOK_AT_CHAIN];
}
export function loadLookAtEnabled(ctx, store) {
    return store.getOverride().enabled ?? ctx.getLookAtSettings().enabled;
}
//# sourceMappingURL=settings.js.map