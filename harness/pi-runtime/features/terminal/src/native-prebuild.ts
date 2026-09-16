import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export interface EnsureVendoredPrebuildResult {
	readonly packageRoot: string | null;
	readonly vendorRoot: string;
	readonly installed: readonly string[];
	readonly skipped: readonly string[];
	readonly errors: readonly string[];
}

/** Directory of host folders this feature vendors for the senpi-pty contract path. */
export function vendoredPrebuildRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "native", "prebuilds");
}

export function senpiPtyPackageRoot(): string {
	return dirname(require.resolve("@code-yeongyu/senpi-pty/package.json"));
}

/** Path `loadNativePty()` looks up first: `native/prebuilds/<host>/senpi_pty.<host>.node`. */
export function contractPrebuildPath(packageRoot: string, host: string): string {
	return join(packageRoot, "native", "prebuilds", host, `senpi_pty.${host}.node`);
}

export function vendoredPrebuildPath(vendorRoot: string, host: string): string {
	return join(vendorRoot, host, `senpi_pty.${host}.node`);
}

export function listVendoredPrebuildHosts(vendorRoot = vendoredPrebuildRoot()): string[] {
	if (!existsSync(vendorRoot)) return [];
	return readdirSync(vendorRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((host) => existsSync(vendoredPrebuildPath(vendorRoot, host)))
		.sort();
}

/**
 * Copy vendored host prebuilds into `@code-yeongyu/senpi-pty` without replacing any
 * file already present. Darwin arm64 stays the npm-shipped artifact.
 */
export function ensureVendoredSenpiPtyPrebuilds(): EnsureVendoredPrebuildResult {
	const vendorRoot = vendoredPrebuildRoot();
	const installed: string[] = [];
	const skipped: string[] = [];
	const errors: string[] = [];

	let packageRoot: string | null = null;
	try {
		packageRoot = senpiPtyPackageRoot();
	} catch (error) {
		return {
			packageRoot: null,
			vendorRoot,
			installed,
			skipped,
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}

	for (const host of listVendoredPrebuildHosts(vendorRoot)) {
		const source = vendoredPrebuildPath(vendorRoot, host);
		const destination = contractPrebuildPath(packageRoot, host);
		if (existsSync(destination)) {
			skipped.push(host);
			continue;
		}
		try {
			mkdirSync(dirname(destination), { recursive: true });
			copyFileSync(source, destination);
			installed.push(host);
		} catch (error) {
			errors.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { packageRoot, vendorRoot, installed, skipped, errors };
}
