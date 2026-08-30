const QUESTION_MODULE_SUFFIX = '/web-ai/question.mjs';
const CHATGPT_MODEL_MODULE_SUFFIX = '/web-ai/chatgpt-model.mjs';
const RAW_PROMPT_ENV = 'CONSULT_AGBROWSE_RAW_PROMPT';
const FUNCTION_MARKER = 'function renderNormalizedEnvelope(envelope) {\n    const blocks = [];';
const COMPOSER_PILL_CLICK_MARKER = `            await composerPill.click({ timeout: 5_000 });
            await page.waitForTimeout(400).catch(() => undefined);
            if (await isModelMenuOpen(page)) {
                await assertOpenMenuIsNotWorkPicker(page);
                return;
            }`;
const COMPOSER_PILL_POINTER_FALLBACK = `${COMPOSER_PILL_CLICK_MARKER}
            // ChatGPT's current composer pill can ignore Playwright's locator
            // click while still accepting a real pointer event at its center.
            // Keep this scoped to the already-verified composer model pill and
            // only try it after the ordinary click failed to open a model menu.
            const composerPillBox = await composerPill.boundingBox().catch(() => null);
            if (composerPillBox) {
                usedFallbacks.push('composer-model-pill-pointer');
                await page.mouse.click(
                    composerPillBox.x + composerPillBox.width / 2,
                    composerPillBox.y + composerPillBox.height / 2,
                ).catch(() => undefined);
                await page.waitForTimeout(400).catch(() => undefined);
                if (await isModelMenuOpen(page)) {
                    await assertOpenMenuIsNotWorkPicker(page);
                    return;
                }
            }`;
const POWER_PICKER_ROOT_MARKER = `const CHATGPT_POWER_PICKER_ROOT_SELECTOR =
    '[role="menu"][data-state="open"]:has([role="menuitem"][aria-label="Power"])';`;
// agbrowse 0.2.x identifies the live Chat Power shell by the Power menuitem.
// Do not rewrite that root to retired content-testid selectors: the current
// shell has no composer-intelligence-picker-content node, so a rewritten
// root never matches, open-detection stays false, and the next click toggles
// the already-open menu shut.
const POWER_PICKER_ROOT_CURRENT = `const CHATGPT_POWER_PICKER_ROOT_SELECTOR =
    '[role="menu"][data-state="open"]:has([role="menuitem"][aria-label="Power"]), [role="menu"][data-state="open"]:has([role="menuitem"][aria-label="성능"])';`;
const MODEL_SURFACE_PREFLIGHT_MARKER = `async function assertChatSurfaceForModelMutation(page) {
    const { detectChatGptComposerSurface } = await import('./product-surfaces.mjs');`;
const SIMPLIFIED_PICKER_OPEN_MARKER = `    const visible = await menu.isVisible().catch(() => false);
    if (!visible) return false;
    if (!model && !effort && await isChatGptPowerPickerOpen(page)) return true;`;
const SIMPLIFIED_PICKER_OPEN_CURRENT = `    const visible = await menu.isVisible().catch(() => false);
    if (!visible) return false;
    if (!model && !effort) {
        // The current localized Chat picker exposes the selected effort in a
        // visible slider, while its menuitemradio rows belong to the hidden
        // advanced model list. Scanning only those hidden rows makes an open
        // menu look closed, so the caller clicks the pill again and toggles it
        // shut. Recognize the locale-independent visible slider structure.
        const simpleView = menu.locator(
            '[data-testid="composer-model-picker-slider-simple-view"]',
        ).first();
        const effortSlider = simpleView.locator(
            '[data-model-reasoning-effort-slider]',
        ).first();
        if (
            await simpleView.isVisible().catch(() => false)
            && await effortSlider.isVisible().catch(() => false)
        ) return true;
    }
    if (!model && !effort && await isChatGptPowerPickerOpen(page)) return true;`;
const TIER_SLIDER_STATE_MARKER = `async function readChatGptPowerSliderState(page) {`;
const TIER_SLIDER_STATE_CURRENT = `async function isChatGptTierSliderOpen(page) {
    const root = chatGptComposerMenuRoot(page);
    if (!(await root.isVisible().catch(() => false))) return false;
    const simpleView = root.locator(
        '[data-testid="composer-model-picker-slider-simple-view"]',
    ).first();
    const effortSlider = simpleView.locator(
        '[data-model-reasoning-effort-slider]',
    ).first();
    return await simpleView.isVisible().catch(() => false)
        && await effortSlider.isVisible().catch(() => false);
}

${TIER_SLIDER_STATE_MARKER}`;
const TIER_SLIDER_DRIVER_MARKER = `async function selectChatGptPowerTierBySlider(page, choice, options = {}) {
    if (!(await isChatGptPowerPickerOpen(page))) return false;
    const effort = options.effort || null;
    const usedFallbacks = options.usedFallbacks || [];
    const targetIndex = powerTierIndexForChoice(choice, effort);
    const power = page.locator('[role="menuitem"][aria-label="Power"]').first();
    if (!(await power.isVisible().catch(() => false))) return false;
    await power.focus({ timeout: 1_000 }).catch(() => undefined);
    await power.click({ timeout: 2_000 }).catch(() => undefined);`;
const TIER_SLIDER_DRIVER_CURRENT = `async function selectChatGptPowerTierBySlider(page, choice, options = {}) {
    if (!(await isChatGptTierSliderOpen(page))) return false;
    const effort = options.effort || null;
    const usedFallbacks = options.usedFallbacks || [];
    const targetIndex = powerTierIndexForChoice(choice, effort);
    const power = page.locator('[role="menuitem"][aria-label="Power"], [role="menuitem"][aria-label="성능"]').first();
    const simpleControl = page.locator(
        '[data-testid="composer-model-picker-slider-simple-view"] [role="menuitem"]:has([data-model-reasoning-effort-slider])',
    ).first();
    const control = await power.isVisible().catch(() => false) ? power : simpleControl;
    if (!(await control.isVisible().catch(() => false))) return false;
    const focused = await control.focus({ timeout: 1_000 })
        .then(() => true)
        .catch(() => false);
    if (!focused) return false;
    const ownsFocus = await control.evaluate(
        element => element === element.ownerDocument.activeElement,
    ).catch(() => false);
    if (!ownsFocus) return false;
    if (control === power) {
        await control.click({ timeout: 2_000 }).catch(() => undefined);
    }`;
const TIER_SLIDER_CALL_MARKER = `if (await isChatGptPowerPickerOpen(page)
                    && await selectChatGptPowerTierBySlider`;
const TIER_SLIDER_CALL_CURRENT = `if (await isChatGptTierSliderOpen(page)
                    && await selectChatGptPowerTierBySlider`;
const CURRENT_MODEL_OPTION_MARKER = `    // Current path: exact labels in composer-scoped menu root.`;
const CURRENT_MODEL_OPTION_CURRENT = `    // The simple slider's "model selection" toggle contains the selected
    // effort text, so label filtering mistakes the toggle for the requested
    // tier and clicks it while the advanced model rows intercept the pointer.
    // Let the dedicated slider driver own this surface instead.
    if (await isChatGptTierSliderOpen(page)) return null;
    // Current path: exact labels in composer-scoped menu root.`;
const CHECKED_MODEL_SLIDER_MARKER = `    const powerPickerOpen = await isChatGptPowerPickerOpen(page);
    if (powerPickerOpen) {
        const sliderState = await readChatGptPowerSliderState(page);`;
const CHECKED_MODEL_SLIDER_CURRENT = `    const tierSliderOpen = await isChatGptTierSliderOpen(page);
    if (tierSliderOpen) {
        const sliderState = await readChatGptPowerSliderState(page);`;
const OBSERVED_EFFORT_SLIDER_MARKER = `    if (requestedEffort && targetModel === 'thinking' && await isChatGptPowerPickerOpen(page)) {`;
const OBSERVED_EFFORT_SLIDER_CURRENT = `    if (requestedEffort && targetModel === 'thinking' && await isChatGptTierSliderOpen(page)) {`;
const SIMPLE_SLIDER_FALLBACK_MARKER = `            if (!sliderApplied) {
                try {`;
const SIMPLE_SLIDER_FALLBACK_CURRENT = `            if (!sliderApplied && await isChatGptTierSliderOpen(page)) {
                // This surface is slider-owned. Falling through to legacy
                // exact-label clicks can mistake the "model selection" toggle
                // for an effort option and click through hidden advanced rows.
                // Preserve fail-closed evidence instead of guessing.
                usedFallbacks.push('reasoning-effort-slider-unverified');
                warnings.push('effort-selection-unverified');
            } else if (!sliderApplied) {
                try {`;
const SIMPLIFIED_EFFORT_EVIDENCE_MARKER = `        const simplifiedSelected = currentEvidence?.label
            ? effortChoiceFromSimplifiedText(currentEvidence.label, /** @type {string} */ (targetModel), requestedEffort)
            : null;`;
const SIMPLIFIED_EFFORT_EVIDENCE_CURRENT = `        const tierSliderOpen = await isChatGptTierSliderOpen(page);
        // On the slider surface, currentEvidence.label contains the whole
        // simple view. A descendant "model selection" line can equal the
        // requested effort even when the thumb is elsewhere. Require the
        // slider label + aria-valuenow cross-check below instead.
        const simplifiedSelected = !tierSliderOpen && currentEvidence?.label
            ? effortChoiceFromSimplifiedText(currentEvidence.label, /** @type {string} */ (targetModel), requestedEffort)
            : null;`;
const MODEL_SURFACE_PREFLIGHT_CURRENT = `async function assertChatSurfaceForModelMutation(page) {
    // ChatGPT may rate-limit conversation-history access on a freshly opened
    // tab. Do not acknowledge and continue: another attempt can extend the
    // account-protection window, and the provider explicitly asks us to wait.
    const historyRateLimitModal = page.locator(
        '[data-testid="modal-conversation-history-rate-limit"]',
    ).first();
    if (await historyRateLimitModal.isVisible().catch(() => false)) {
        throw new WebAiError({
            errorCode: 'provider.rate-limited',
            stage: 'provider-surface-preflight',
            vendor: 'chatgpt',
            retryHint: 'wait',
            message: 'ChatGPT temporarily limited conversation-history access; wait a few minutes before retrying',
            evidence: { modal: 'modal-conversation-history-rate-limit' },
        });
    }
    const { detectChatGptComposerSurface } = await import('./product-surfaces.mjs');`;

const RAW_PROMPT_BRANCH = `function renderNormalizedEnvelope(envelope) {
    if (process.env.${RAW_PROMPT_ENV} === '1') {
        const composerText = envelope.question || envelope.prompt;
        if (composerText.length > INLINE_CHAR_LIMIT) {
            throw new WebAiError({
                errorCode: 'context.over-budget',
                stage: 'context-preflight',
                retryHint: 'reduce-files',
                message: \`inline prompt too large: \${composerText.length}/\${INLINE_CHAR_LIMIT} chars\`,
                evidence: { length: composerText.length, limit: INLINE_CHAR_LIMIT },
            });
        }
        return {
            markdown: composerText,
            composerText,
            estimatedChars: composerText.length,
            warnings: [],
        };
    }
    const blocks = [];`;

export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    if (process.env[RAW_PROMPT_ENV] !== '1') {
        return result;
    }

    const source = String(result.source);
    if (url.endsWith(QUESTION_MODULE_SUFFIX)) {
        if (!source.includes(FUNCTION_MARKER) || !source.includes("renderTrustedSection('USER'")) {
            throw new Error(
                'Consult raw-prompt transport is incompatible with this agbrowse question renderer; ' +
                'verify the installed agbrowse release before sending.',
            );
        }

        return {
            ...result,
            source: source.replace(FUNCTION_MARKER, RAW_PROMPT_BRANCH),
        };
    }

    if (url.endsWith(CHATGPT_MODEL_MODULE_SUFFIX)) {
        // Every anchor below is load-bearing. An unchecked `.replace()` whose
        // needle stopped matching returns the source silently unpatched, which
        // is exactly how the '추론 강도' mismatch degraded into
        // `model-not-enforced` instead of a visible error. Fail closed on all
        // of them, including the locale wideners, so an agbrowse upgrade that
        // moves any one of these lines stops the run instead of quietly
        // dropping tier enforcement.
        const requiredAnchors = [
            COMPOSER_PILL_CLICK_MARKER,
            POWER_PICKER_ROOT_MARKER,
            MODEL_SURFACE_PREFLIGHT_MARKER,
            SIMPLIFIED_PICKER_OPEN_MARKER,
            TIER_SLIDER_STATE_MARKER,
            TIER_SLIDER_DRIVER_MARKER,
            TIER_SLIDER_CALL_MARKER,
            CURRENT_MODEL_OPTION_MARKER,
            CHECKED_MODEL_SLIDER_MARKER,
            OBSERVED_EFFORT_SLIDER_MARKER,
            SIMPLE_SLIDER_FALLBACK_MARKER,
            SIMPLIFIED_EFFORT_EVIDENCE_MARKER,
            `root.locator('[role="menuitem"][aria-label="Power"]')`,
            `page.locator('[role="menuitem"][aria-label="Power"]')`,
            `hasModel ||= menuTextHasExactLine(text, 'Model');`,
            `hasEffort ||= menuTextHasExactLine(text, 'Effort');`,
            `if (menuTextHasExactLine(text, heading)) return trigger;`,
        ];
        const missing = requiredAnchors.filter((anchor) => !source.includes(anchor));
        if (missing.length > 0) {
            throw new Error(
                'Consult model-picker compatibility patch does not match this agbrowse release; ' +
                'verify the installed agbrowse release before sending. Missing anchors: ' +
                missing.join(' | '),
            );
        }
        const patched = source
            .replace(COMPOSER_PILL_CLICK_MARKER, COMPOSER_PILL_POINTER_FALLBACK)
            .replace(POWER_PICKER_ROOT_MARKER, POWER_PICKER_ROOT_CURRENT)
            .replace(MODEL_SURFACE_PREFLIGHT_MARKER, MODEL_SURFACE_PREFLIGHT_CURRENT)
            .replace(SIMPLIFIED_PICKER_OPEN_MARKER, SIMPLIFIED_PICKER_OPEN_CURRENT)
            .replace(TIER_SLIDER_STATE_MARKER, TIER_SLIDER_STATE_CURRENT)
            .replace(TIER_SLIDER_DRIVER_MARKER, TIER_SLIDER_DRIVER_CURRENT)
            .replaceAll(TIER_SLIDER_CALL_MARKER, TIER_SLIDER_CALL_CURRENT)
            .replace(CURRENT_MODEL_OPTION_MARKER, CURRENT_MODEL_OPTION_CURRENT)
            .replace(CHECKED_MODEL_SLIDER_MARKER, CHECKED_MODEL_SLIDER_CURRENT)
            .replace(OBSERVED_EFFORT_SLIDER_MARKER, OBSERVED_EFFORT_SLIDER_CURRENT)
            .replace(SIMPLE_SLIDER_FALLBACK_MARKER, SIMPLE_SLIDER_FALLBACK_CURRENT)
            .replace(SIMPLIFIED_EFFORT_EVIDENCE_MARKER, SIMPLIFIED_EFFORT_EVIDENCE_CURRENT)
            .replaceAll(
                `root.locator('[role="menuitem"][aria-label="Power"]')`,
                `root.locator('[role="menuitem"][aria-label="Power"], [role="menuitem"][aria-label="성능"]')`,
            )
            .replaceAll(
                `page.locator('[role="menuitem"][aria-label="Power"]')`,
                `page.locator('[role="menuitem"][aria-label="Power"], [role="menuitem"][aria-label="성능"]')`,
            )
            .replace(
                `hasModel ||= menuTextHasExactLine(text, 'Model');`,
                `hasModel ||= menuTextHasExactLine(text, 'Model') || menuTextHasExactLine(text, '모델');`,
            )
            .replace(
                `hasEffort ||= menuTextHasExactLine(text, 'Effort');`,
                `hasEffort ||= menuTextHasExactLine(text, 'Effort') || menuTextHasExactLine(text, '추론 수준') || menuTextHasExactLine(text, '추론 강도');`,
            )
            .replace(
                `if (menuTextHasExactLine(text, heading)) return trigger;`,
                `if (menuTextHasExactLine(text, heading)
                    || (heading === 'Model' && menuTextHasExactLine(text, '모델'))
                    || (heading === 'Effort' && (menuTextHasExactLine(text, '추론 수준') || menuTextHasExactLine(text, '추론 강도')))) return trigger;`,
            );
        return {
            ...result,
            source: patched,
        };
    }

    return result;
}
