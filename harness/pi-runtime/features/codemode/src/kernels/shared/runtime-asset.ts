export interface CodemodeRuntimeAssetEnvironment {
	readonly bunVersion?: string;
	readonly executablePath?: string;
}

export function resolveCodemodeRuntimeAsset(
	localPath: string,
	_packageRelativePath: string,
	_environment: CodemodeRuntimeAssetEnvironment = {},
): string {
	// The runtime feature stages the complete source and asset tree together.
	// Never escape to an installed Senpi package when an owned asset is missing.
	return localPath;
}
