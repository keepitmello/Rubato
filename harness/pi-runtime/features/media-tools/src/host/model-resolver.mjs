const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function isValidThinkingLevel(level) {
	return VALID_THINKING_LEVELS.has(level);
}

function isAlias(id) {
	if (id.endsWith("-latest")) return true;
	return !/-\d{8}$/.test(id);
}

/** Stock Pi's exact-id/canonical-reference rule, kept local because it is not a package-root export. */
export function findExactModelReferenceMatch(modelReference, availableModels) {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) return undefined;
	const normalizedReference = trimmedReference.toLowerCase();
	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) return canonicalMatches[0];
	if (canonicalMatches.length > 1) return undefined;

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.slice(0, slashIndex).trim();
		const modelId = trimmedReference.slice(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) return providerMatches[0];
			if (providerMatches.length > 1) return undefined;
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

function tryMatchModel(modelPattern, availableModels) {
	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) return exactMatch;
	const matches = availableModels.filter(
		(model) =>
			model.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			model.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);
	if (matches.length === 0) return undefined;
	const aliases = matches.filter((model) => isAlias(model.id));
	if (aliases.length > 0) return aliases.sort((a, b) => b.id.localeCompare(a.id))[0];
	return matches.filter((model) => !isAlias(model.id)).sort((a, b) => b.id.localeCompare(a.id))[0];
}

/** Current look_at model-pattern semantics without importing a non-exported stock module. */
export function parseModelPattern(pattern, availableModels, options) {
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) return { model: undefined, thinkingLevel: undefined, warning: undefined };
	const prefix = pattern.slice(0, lastColonIndex);
	const suffix = pattern.slice(lastColonIndex + 1);
	if (isValidThinkingLevel(suffix)) {
		const result = parseModelPattern(prefix, availableModels, options);
		if (!result.model) return result;
		return {
			model: result.model,
			thinkingLevel: result.warning ? undefined : suffix,
			warning: result.warning,
		};
	}
	if (options?.allowInvalidThinkingLevelFallback === false) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}
	const result = parseModelPattern(prefix, availableModels, options);
	if (!result.model) return result;
	return {
		model: result.model,
		thinkingLevel: undefined,
		warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
	};
}
